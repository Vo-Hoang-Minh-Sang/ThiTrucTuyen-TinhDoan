import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createRateLimiter, validateAuthConfiguration } from './security.js';
import { createAccess, publicUser, USER_FIELDS } from './access.js';

export { validateAuthConfiguration } from './security.js';

const RESET_MESSAGE = 'Nếu tài khoản tồn tại, yêu cầu hỗ trợ đặt lại mật khẩu đã được ghi nhận. Vui lòng liên hệ quản trị viên để xác minh và nhận mật khẩu tạm thời.';
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const normalizePhone = value => typeof value === 'string' ? value.trim().replace(/[\s.-]/g, '') : '';
const validEmail = value => value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const validPhone = value => /^\+?\d{9,15}$/.test(value);
// Giới hạn theo byte UTF-8 để bcrypt không âm thầm cắt phần mật khẩu vượt quá 72 byte.
const validPassword = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
const failure = (response, status, code, message, extra = {}) => response.status(status).json({ success: false, code, message, ...extra });
// Chuyển lỗi từ các hàm xử lý bất đồng bộ về bộ xử lý lỗi chung của Express.
const route = handler => (request, response, next) => Promise.resolve(handler(request, response)).catch(next);

// Chuẩn hóa email hoặc điện thoại thành một định danh dùng để tìm tài khoản.
function parseIdentifier(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const email = normalizeEmail(value);
  const phone = normalizePhone(value);
  return validEmail(email) ? { email, phone: null, key: email } : validPhone(phone) ? { email: null, phone, key: phone } : null;
}

// Nhận kết nối dữ liệu và hàm gửi email từ bên ngoài để có thể thay thế khi kiểm thử.
export function createAuthRouter({ pool, sendOtpEmail, env = process.env, limiter = createRateLimiter() }) {
  const config = validateAuthConfiguration(env);
  const router = express.Router();
  const authenticate = createAccess({ pool, env, allowPasswordChange: true });
  // Luồng OTP giữ lại cho giai đoạn sau và chỉ hoạt động khi bật rõ OTP_ENABLED.
  router.use((request, response, next) => {
    if (!config.otpEnabled && ['/verify-registration', '/resend-registration', '/reset-password'].includes(request.path)) return failure(response, 409, 'OTP_DISABLED', 'OTP hiện chưa sử dụng. Hãy liên hệ quản trị viên để được hỗ trợ.');
    next();
  });
  router.use((request, response, next) => {
    if (request.method === 'POST' && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))) {
      return failure(response, 400, 'VALIDATION_ERROR', 'Nội dung yêu cầu phải là đối tượng JSON.');
    }
    next();
  });

  // Áp dụng đồng thời giới hạn theo IP và định danh; báo thời gian chờ qua Retry-After.
  function throttle(request, response, scope, identifier, accountLimit, windowMs) {
    const attempts = [limiter.consume(`${scope}:ip`, request.ip || 'unknown', scope === 'issue' ? 20 : 40, windowMs)];
    if (identifier) attempts.push(limiter.consume(`${scope}:account`, identifier, accountLimit, windowMs));
    const blocked = attempts.find(attempt => !attempt.allowed);
    if (!blocked) return false;
    response.set('Retry-After', String(blocked.retryAfter));
    failure(response, 429, 'RATE_LIMITED', 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.', { retryAfter: blocked.retryAfter });
    return true;
  }

  async function findUser(db, identifier, lock = false) {
    const [rows] = await db.query(`SELECT ${USER_FIELDS} FROM users WHERE email = ? OR dienthoai = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [identifier.email, identifier.phone]);
    return rows[0];
  }

  // Chỉ xét mã mới nhất của từng mục đích và khóa bản ghi trong giao dịch đang xử lý.
  async function latestOtp(db, userId, purpose) {
    const [rows] = await db.query(`SELECT id, otp_hash, attempts, verified_at,
      expires_at > NOW() AS unexpired, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds
      FROM otp_verifications WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`, [userId, purpose]);
    return rows[0];
  }

  async function deliverOtp(issued, otp, purpose) {
    try {
      await sendOtpEmail({ to: issued.email, otp, purpose });
      return { email: issued.email, ...(config.developmentOtp ? { devOtp: otp } : {}) };
    } catch {
      // Cho mã hết hạn ngay khi gửi email lỗi nhưng vẫn giữ trạng thái chưa sử dụng
      // để tài khoản có thể yêu cầu gửi lại; không trả chi tiết kết nối SMTP cho người dùng.
      await pool.query('UPDATE otp_verifications SET expires_at = NOW() WHERE id = ? AND verified_at IS NULL', [issued.id]);
      return { deliveryFailed: true, email: issued.email };
    }
  }

  async function issueOtp(userId, purpose) {
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const issued = await pool.transaction(async tx => {
      // Khóa tài khoản trước rồi đến OTP để các yêu cầu gửi lại và xác nhận được xử lý lần lượt.
      const [[user]] = await tx.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ? FOR UPDATE`, [userId]);
      if (!user?.email) return { unavailable: true };
      const previous = await latestOtp(tx, user.id, purpose);
      // Mã đăng ký mới nhất đã dùng cho biết đăng ký đã hoàn tất, kể cả khi tài khoản
      // bị vô hiệu hóa sau đó; gửi lại OTP không được kích hoạt lại những tài khoản này.
      if (purpose === 'register' && (Number(user.is_active) === 1 || !previous || previous.verified_at)) return { unavailable: true };
      // MySQL có thể trả kết quả so sánh dưới dạng chuỗi '0'/'1', nên cần đổi sang số.
      if (previous && !previous.verified_at && Number(previous.unexpired) === 1 && Number(previous.age_seconds) < 60) {
        return { cooldown: Math.max(1, 60 - Number(previous.age_seconds)) };
      }
      await tx.query('UPDATE otp_verifications SET verified_at = NOW() WHERE user_id = ? AND purpose = ? AND verified_at IS NULL', [user.id, purpose]);
      const [result] = await tx.query('INSERT INTO otp_verifications (user_id, purpose, otp_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))', [user.id, purpose, otpHash, config.otpExpiresMinutes]);
      return { id: result.insertId, email: user.email };
    });
    if (!issued.id) return issued;
    // Gửi email sau khi hoàn tất giao dịch để không giữ khóa dữ liệu trong lúc chờ SMTP.
    return deliverOtp(issued, otp, purpose);
  }

  // Kiểm tra mã, cập nhật tài khoản và đánh dấu đã dùng trong cùng giao dịch để tránh dùng mã hai lần.
  async function consumeOtp(identifier, purpose, otp, onSuccess) {
    return pool.transaction(async tx => {
      const user = await findUser(tx, identifier, true);
      if (!user || (purpose === 'register' && Number(user.is_active) === 1)) return false;
      const record = await latestOtp(tx, user.id, purpose);
      if (!record || record.verified_at || Number(record.unexpired) !== 1 || Number(record.attempts) >= 5) return false;
      const valid = await bcrypt.compare(otp, record.otp_hash);
      await tx.query('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?', [record.id]);
      // Trả về false thay vì ném lỗi để giao dịch vẫn lưu số lần nhập sai.
      if (!valid) return false;
      await onSuccess(tx, user);
      await tx.query('UPDATE otp_verifications SET verified_at = NOW() WHERE id = ?', [record.id]);
      return true;
    });
  }

  function otpResponse(response, issued, success, extra = {}, status = 200) {
    if (issued.cooldown) {
      response.set('Retry-After', String(issued.cooldown));
      return failure(response, 429, 'RATE_LIMITED', 'Vui lòng chờ trước khi gửi lại OTP.', { ...extra, retryAfter: issued.cooldown });
    }
    if (issued.deliveryFailed) return failure(response, 503, 'OTP_DELIVERY_FAILED', 'Chưa thể gửi email OTP. Vui lòng thử gửi lại mã.', { ...extra, ...(issued.email ? { email: issued.email } : {}) });
    if (issued.unavailable) return failure(response, 400, 'REGISTRATION_UNAVAILABLE', 'Tài khoản không có đăng ký đang chờ xác nhận.');
    return response.status(status).json({ success: true, message: success, ...extra, ...issued });
  }

  router.post('/register', route(async (request, response) => {
    const { hoten, dienthoai, email, password, donviID } = request.body;
    const phone = normalizePhone(dienthoai);
    const normalizedEmail = normalizeEmail(email);
    const unit = typeof donviID === 'number' || typeof donviID === 'string' ? Number(donviID) : NaN;
    const errors = {};
    if (typeof hoten !== 'string' || !hoten.trim() || hoten.trim().length > 255) errors.hoten = 'Họ tên từ 1 đến 255 ký tự.';
    if (!validPhone(phone)) errors.dienthoai = 'Số điện thoại phải gồm 9 đến 15 chữ số.';
    if (!validEmail(normalizedEmail)) errors.email = 'Email không hợp lệ.';
    if (!validPassword(password)) errors.password = 'Mật khẩu cần ít nhất 8 ký tự và không quá 72 byte UTF-8.';
    if (!Number.isSafeInteger(unit) || unit <= 0) errors.donviID = 'Vui lòng chọn đơn vị hợp lệ.';
    if (Object.keys(errors).length) return failure(response, 400, 'VALIDATION_ERROR', Object.values(errors)[0], { errors });
    if (throttle(request, response, 'issue', normalizedEmail, 3, 15 * 60 * 1000)) return;
    const [units] = await pool.query('SELECT id FROM donvi WHERE id = ? LIMIT 1', [unit]);
    if (!units.length) return failure(response, 400, 'VALIDATION_ERROR', 'Đơn vị đã chọn không tồn tại.', { errors: { donviID: 'Đơn vị đã chọn không tồn tại.' } });
    const [existing] = await pool.query('SELECT id FROM users WHERE dienthoai = ? OR email = ? LIMIT 1', [phone, normalizedEmail]);
    if (existing.length) return failure(response, 409, 'ACCOUNT_EXISTS', 'Email hoặc số điện thoại đã đăng ký.');
    const passwordHash = await bcrypt.hash(password, 12);
    if (!config.otpEnabled) {
      try {
        // Đăng ký công khai luôn là thí sinh; không nhận vai trò hoặc quyền từ trình duyệt.
        const [created] = await pool.query("INSERT INTO users (hoten, dienthoai, email, donviID, password, is_active, role) VALUES (?, ?, ?, ?, ?, 1, 'candidate')", [hoten.trim(), phone, normalizedEmail, unit, passwordHash]);
        return response.status(201).json({ success: true, userId: created.insertId, registrationPending: false, message: 'Đăng ký thành công. Bạn có thể đăng nhập ngay.' });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.driverError?.code === 'ER_DUP_ENTRY') return failure(response, 409, 'ACCOUNT_EXISTS', 'Email hoặc số điện thoại đã được đăng ký.');
        throw error;
      }
    }
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    let created;
    try {
      // Tạo tài khoản và OTP đầu tiên cùng lúc; nếu lưu OTP lỗi thì không để lại tài khoản bị kẹt.
      created = await pool.transaction(async tx => {
        const [result] = await tx.query('INSERT INTO users (hoten, dienthoai, email, donviID, password, is_active) VALUES (?, ?, ?, ?, ?, 0)', [hoten.trim(), phone, normalizedEmail, unit, passwordHash]);
        const [otpResult] = await tx.query('INSERT INTO otp_verifications (user_id, purpose, otp_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))', [result.insertId, 'register', otpHash, config.otpExpiresMinutes]);
        return { userId: result.insertId, id: otpResult.insertId, email: normalizedEmail };
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' || error.driverError?.code === 'ER_DUP_ENTRY') return failure(response, 409, 'ACCOUNT_EXISTS', 'Email hoặc số điện thoại đã được đăng ký.');
      throw error;
    }
    const issued = await deliverOtp(created, otp, 'register');
    return otpResponse(response, issued, 'Đăng ký thành công. Hãy nhập OTP đã gửi về email.', { registrationPending: true, userId: created.userId, email: normalizedEmail }, 201);
  }));

  router.post('/resend-registration', route(async (request, response) => {
    const identifier = parseIdentifier(request.body.identifier || request.body.dienthoai);
    if (!identifier) return failure(response, 400, 'VALIDATION_ERROR', 'Vui lòng nhập email hoặc số điện thoại hợp lệ.');
    if (throttle(request, response, 'issue', identifier.key, 3, 15 * 60 * 1000)) return;
    const user = await findUser(pool, identifier);
    if (!user) return failure(response, 400, 'REGISTRATION_UNAVAILABLE', 'Tài khoản không có đăng ký đang chờ xác nhận.');
    return otpResponse(response, await issueOtp(user.id, 'register'), 'OTP xác nhận mới đã được gửi về email.', { registrationPending: true });
  }));

  router.post('/verify-registration', route(async (request, response) => {
    const identifier = parseIdentifier(request.body.identifier || request.body.dienthoai);
    const otp = request.body.otp;
    if (!identifier || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return failure(response, 400, 'VALIDATION_ERROR', 'Vui lòng nhập email/số điện thoại hợp lệ và OTP gồm 6 chữ số.');
    if (throttle(request, response, 'verify', identifier.key, 10, 15 * 60 * 1000)) return;
    const valid = await consumeOtp(identifier, 'register', otp, (tx, user) => tx.query('UPDATE users SET is_active = 1, token_version = token_version + 1 WHERE id = ?', [user.id]));
    if (!valid) return failure(response, 400, 'INVALID_OTP', 'OTP không đúng, đã sử dụng hoặc đã hết hạn.');
    return response.json({ success: true, message: 'Xác nhận tài khoản thành công.' });
  }));

  router.post('/login', route(async (request, response) => {
    const identifier = parseIdentifier(request.body.identifier);
    const password = request.body.password;
    if (!identifier || typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) return failure(response, 400, 'VALIDATION_ERROR', 'Vui lòng nhập email/số điện thoại và mật khẩu hợp lệ.');
    if (throttle(request, response, 'login', identifier.key, 5, 15 * 60 * 1000)) return;
    // Khóa tài khoản khi cấp phiên để việc đổi mật khẩu không tạo JWT từ mật khẩu cũ.
    const session = await pool.transaction(async tx => {
      const user = await findUser(tx, identifier, true);
      if (!user || Number(user.is_active) !== 1 || !['candidate', 'teacher', 'admin'].includes(user.role) || typeof user.password !== 'string') return null;
      // Dữ liệu tài khoản cũ có thể chứa chuỗi mật khẩu băm hỏng; trả lỗi đăng nhập thay vì làm hỏng toàn bộ API.
      let passwordMatches = false;
      try { passwordMatches = await bcrypt.compare(password, user.password); } catch { return null; }
      if (!passwordMatches) return null;
      const jti = crypto.randomUUID();
      const token = jwt.sign({ sub: String(user.id), ver: Number(user.token_version || 0) }, config.secret, { jwtid: jti, expiresIn: config.expiresIn, algorithm: 'HS256' });
      const expiresAt = new Date(jwt.decode(token).exp * 1000);
      await tx.query('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [jti, user.id, expiresAt]);
      await tx.query('UPDATE users SET countLogin = countLogin + 1 WHERE id = ?', [user.id]);
      return { token, user: publicUser(user) };
    });
    if (!session) return failure(response, 401, 'INVALID_CREDENTIALS', 'Thông tin đăng nhập không đúng hoặc tài khoản đã bị khóa.');
    return response.json({ success: true, ...session });
  }));

  router.post('/request-password-reset', route(async (request, response) => {
    const identifier = parseIdentifier(request.body.identifier);
    if (!identifier) return failure(response, 400, 'VALIDATION_ERROR', 'Vui lòng nhập email hoặc số điện thoại hợp lệ.');
    if (throttle(request, response, 'issue', identifier.key, 3, 15 * 60 * 1000)) return;
    if (!config.otpEnabled) {
      await pool.transaction(async tx => {
        const user = await findUser(tx, identifier, true);
        if (!user || !['candidate', 'teacher'].includes(user.role)) return;
        const [[pending]] = await tx.query("SELECT id FROM password_reset_requests WHERE user_id = ? AND status = 'pending' LIMIT 1", [user.id]);
        if (!pending) await tx.query('INSERT INTO password_reset_requests (user_id) VALUES (?)', [user.id]);
      });
      // Phản hồi giống nhau cho tài khoản có và không tồn tại; không cấp token đặt lại ở đây.
      return response.json({ success: true, message: RESET_MESSAGE });
    }
    const user = await findUser(pool, identifier);
    if (!user?.email) return response.json({ success: true, message: RESET_MESSAGE });
    const issued = await issueOtp(user.id, 'reset_password');
    // Không tiết lộ email đã đăng ký khi người dùng yêu cầu đặt lại mật khẩu bằng điện thoại.
    delete issued.email;
    if (issued.unavailable) return response.json({ success: true, message: RESET_MESSAGE });
    return otpResponse(response, issued, RESET_MESSAGE);
  }));

  router.post('/reset-password', route(async (request, response) => {
    const identifier = parseIdentifier(request.body.identifier);
    const { otp, newPassword } = request.body;
    if (!identifier || typeof otp !== 'string' || !/^\d{6}$/.test(otp) || !validPassword(newPassword)) return failure(response, 400, 'VALIDATION_ERROR', 'Cần email/số điện thoại hợp lệ, OTP 6 chữ số và mật khẩu mới ít nhất 8 ký tự (tối đa 72 byte UTF-8).');
    if (throttle(request, response, 'verify', identifier.key, 10, 15 * 60 * 1000)) return;
    const hash = await bcrypt.hash(newPassword, 12);
    // Đổi mật khẩu thu hồi các phiên cũ nhưng giữ nguyên trạng thái hoạt động của tài khoản.
    const valid = await consumeOtp(identifier, 'reset_password', otp, (tx, user) => tx.query('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?', [hash, user.id]));
    if (!valid) return failure(response, 400, 'INVALID_OTP', 'OTP không đúng, đã sử dụng hoặc đã hết hạn.');
    return response.json({ success: true, message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.' });
  }));

  router.get('/me', authenticate, route(async (request, response) => {
    response.json({ success: true, user: request.user });
  }));

  router.post('/change-password', authenticate, route(async (request, response) => {
    const { currentPassword, newPassword } = request.body;
    if (typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword) > 72 || !validPassword(newPassword)) return failure(response, 400, 'VALIDATION_ERROR', 'Nhập mật khẩu hiện tại và mật khẩu mới ít nhất 8 ký tự, tối đa 72 byte UTF-8.');
    if (currentPassword === newPassword) return failure(response, 400, 'VALIDATION_ERROR', 'Mật khẩu mới phải khác mật khẩu hiện tại.');
    if (throttle(request, response, 'change', String(request.user.id), 5, 15 * 60 * 1000)) return;
    const hash = await bcrypt.hash(newPassword, 12);
    const changed = await pool.transaction(async tx => {
      const [[user]] = await tx.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ? FOR UPDATE`, [request.user.id]);
      if (!user || Number(user.is_active) !== 1 || Number(user.token_version) !== request.auth.ver || !(await bcrypt.compare(currentPassword, user.password))) return false;
      await tx.query('UPDATE users SET password = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?', [hash, user.id]);
      await tx.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
      await tx.query("INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES (?, 'password_changed', 'user', ?)", [user.id, String(user.id)]);
      return true;
    });
    if (!changed) return failure(response, 400, 'INVALID_PASSWORD', 'Mật khẩu hiện tại không đúng hoặc phiên đăng nhập đã thay đổi.');
    return response.json({ success: true, message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.' });
  }));

  router.post('/logout', authenticate, route(async (request, response) => {
    // Chỉ thu hồi mã phiên hiện tại, giữ các thiết bị khác đang đăng nhập.
    await pool.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [request.auth.jti, request.user.id]);
    response.json({ success: true, message: 'Đã đăng xuất phiên hiện tại.' });
  }));

  return router;
}
