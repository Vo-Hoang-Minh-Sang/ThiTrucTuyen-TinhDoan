import jwt from 'jsonwebtoken';
import { validateAuthConfiguration } from './security.js';

export const ROLES = Object.freeze(['candidate', 'teacher', 'admin']);
export const PERMISSIONS = Object.freeze(['questions', 'exams', 'candidates', 'reports']);
export const USER_FIELDS = 'id, hoten, dienthoai, email, chuc_vu, password, donviID, is_active, token_version, role, permissions, must_change_password';

// Chỉ chấp nhận các quyền đã được hệ thống định nghĩa, kể cả khi dữ liệu cũ bị sai.
export function parsePermissions(value) {
  let items = value;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { return []; }
  }
  return Array.isArray(items) ? [...new Set(items.filter(item => PERMISSIONS.includes(item)))] : [];
}

export function publicUser(user) {
  return {
    id: user.id, hoten: user.hoten, dienthoai: user.dienthoai, email: user.email, chucVu: user.chuc_vu || 'Đoàn viên', donviID: user.donviID,
    is_active: Number(user.is_active) === 1, role: user.role,
    permissions: user.role === 'admin' ? [...PERMISSIONS] : parsePermissions(user.permissions),
    must_change_password: Number(user.must_change_password) === 1
  };
}

const reject = (response, status, code, message) => response.status(status).json({ success: false, code, message });

// Đọc trạng thái, quyền và phiên từ database ở mỗi yêu cầu; JWT không phải nguồn quyền hiện tại.
export function createAccess({ pool, env = process.env, allowPasswordChange = false }) {
  const { secret } = validateAuthConfiguration(env);
  return async (request, response, next) => {
    try {
      const authorization = request.headers.authorization || '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 4096) return reject(response, 401, 'UNAUTHORIZED', 'Thiếu token xác thực hợp lệ.');
      let payload;
      try { payload = jwt.verify(authorization.slice(7), secret, { algorithms: ['HS256'] }); }
      catch { return reject(response, 401, 'UNAUTHORIZED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.'); }
      if (!payload || typeof payload !== 'object' || !/^[1-9]\d*$/.test(String(payload.sub || '')) || !Number.isSafeInteger(payload.ver) || payload.ver < 0 || !/^[0-9a-f-]{36}$/i.test(payload.jti || '')) {
        return reject(response, 401, 'UNAUTHORIZED', 'Phiên đăng nhập không hợp lệ.');
      }
      const [[user]] = await pool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [payload.sub]);
      if (!user || Number(user.is_active) !== 1 || Number(user.token_version) !== payload.ver || !ROLES.includes(user.role)) return reject(response, 401, 'UNAUTHORIZED', 'Phiên đăng nhập đã bị thu hồi hoặc tài khoản không hoạt động.');
      const [[session]] = await pool.query('SELECT id FROM auth_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > NOW()', [payload.jti, user.id]);
      if (!session) return reject(response, 401, 'UNAUTHORIZED', 'Phiên đăng nhập đã bị thu hồi hoặc hết hạn.');
      request.user = publicUser(user);
      request.auth = payload;
      if (!allowPasswordChange && request.user.must_change_password) return reject(response, 403, 'PASSWORD_CHANGE_REQUIRED', 'Bạn cần đổi mật khẩu tạm thời trước khi sử dụng chức năng này.');
      return next();
    } catch (error) { return next(error); }
  };
}

export const requireRoles = (...roles) => (request, response, next) => roles.includes(request.user?.role)
  ? next() : reject(response, 403, 'FORBIDDEN', 'Bạn không có quyền sử dụng chức năng này.');

// Giảng viên cần cả quyền thao tác và phân công vào kỳ thi tương ứng.
export async function assertCompetitionAccess(pool, user, competitionId, permission) {
  const forbidden = () => Object.assign(new Error('Bạn không có quyền thao tác trong kỳ thi này.'), { status: 403, code: 'FORBIDDEN' });
  if (!PERMISSIONS.includes(permission)) throw forbidden();
  if (user?.role === 'admin') return;
  if (user?.role !== 'teacher' || !parsePermissions(user.permissions).includes(permission)) throw forbidden();
  const [[assignment]] = await pool.query('SELECT user_id FROM teacher_competitions WHERE user_id = ? AND competition_id = ?', [user.id, competitionId]);
  if (!assignment) throw forbidden();
}
