// Kiểm thử API tài khoản và các giới hạn xác thực bằng dữ liệu trong bộ nhớ.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createAuthRouter } from '../src/auth/auth.js';
import { createRateLimiter, validateAuthConfiguration } from '../src/auth/security.js';
import { createAccess, assertCompetitionAccess } from '../src/auth/access.js';

const env = { JWT_SECRET: 'test-only-92e44e27f821672f9ae6187166154f04', JWT_EXPIRES_IN: '2h', NODE_ENV: 'test' };
const registration = { hoten: 'Nguyễn Minh Anh', dienthoai: '0901234567', email: 'minhanh@example.com', password: 'StrongPass123!', donviID: 1 };

// Bộ giả lập chỉ hiểu các truy vấn SQL mà module auth đang dùng.
// Giao dịch xếp hàng truy cập và khôi phục dữ liệu khi lỗi để kiểm tra khóa/hoàn tác,
// không kết nối database thật hoặc dịch vụ gửi email.
function memoryPool() {
  let state = { users: [], otps: [], sessions: [], requests: [], audits: [], assignments: [] };
  let queue = Promise.resolve();
  const pool = {
    get state() { return state; },
    failOtpInsert: false,
    async transaction(callback) {
      let release;
      const waiting = queue;
      queue = new Promise(resolve => { release = resolve; });
      await waiting;
      const snapshot = structuredClone(state);
      try { return await callback({ query: pool.query.bind(pool) }); }
      catch (error) { state = snapshot; throw error; }
      finally { release(); }
    },
    async query(raw, args = []) {
      const sql = raw.replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql.startsWith('select id from donvi')) return [args[0] === 1 ? [{ id: 1 }] : []];
      if (sql.startsWith('select') && sql.includes('from users')) {
        let rows;
        if (sql.includes('where id = ?')) rows = state.users.filter(user => String(user.id) === String(args[0]));
        else if (sql.includes('where dienthoai = ?')) rows = state.users.filter(user => user.dienthoai === args[0] || user.email === args[1]);
        else rows = state.users.filter(user => user.email === args[0] || user.dienthoai === args[1]);
        return [structuredClone(rows)];
      }
      if (sql.startsWith('insert into users')) {
        if (state.users.some(user => user.email === args[2] || user.dienthoai === args[1])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        const id = state.users.length + 1;
        state.users.push({ id, hoten: args[0], dienthoai: args[1], email: args[2], donviID: args[3], password: args[4], is_active: sql.includes("1, 'candidate'") ? 1 : 0, token_version: 0, countLogin: 0, role: 'candidate', permissions: [], must_change_password: 0 });
        return [{ insertId: id }];
      }
      if (sql.startsWith('insert into auth_sessions')) {
        state.sessions.push({ id: args[0], user_id: args[1], expires_at: args[2], revoked_at: null });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('select') && sql.includes('from auth_sessions')) return [state.sessions.filter(session => session.id === args[0] && session.user_id === args[1] && !session.revoked_at && session.expires_at > new Date())];
      if (sql.startsWith('update auth_sessions')) {
        const rows = state.sessions.filter(session => sql.includes('where user_id') ? session.user_id === args[0] : session.id === args[0] && session.user_id === args[1]);
        rows.forEach(session => { session.revoked_at = new Date(); });
        return [{ affectedRows: rows.length }];
      }
      if (sql.startsWith('select') && sql.includes('from password_reset_requests')) return [state.requests.filter(item => item.user_id === args[0] && item.status === 'pending')];
      if (sql.startsWith('insert into password_reset_requests')) {
        state.requests.push({ id: state.requests.length + 1, user_id: args[0], status: 'pending' });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('insert into audit_logs')) {
        state.audits.push(args);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('select') && sql.includes('from teacher_competitions')) return [state.assignments.filter(item => item.user_id === args[0] && item.competition_id === args[1])];
      if (sql.startsWith('insert into otp_verifications')) {
        if (pool.failOtpInsert) throw new Error('simulated OTP storage failure');
        const id = state.otps.length + 1;
        state.otps.push({ id, user_id: args[0], purpose: args[1], otp_hash: args[2], expires_at: Date.now() + args[3] * 60000, created_at: Date.now(), attempts: 0, verified_at: null });
        return [{ insertId: id }];
      }
      if (sql.startsWith('select') && sql.includes('from otp_verifications')) {
        assert.match(sql, /for update$/, 'OTP row must be locked while inspecting it');
        const record = state.otps.filter(otp => otp.user_id === args[0] && otp.purpose === args[1]).at(-1);
        return [record ? [{ ...record, unexpired: record.expires_at > Date.now() ? '1' : '0', age_seconds: String(Math.floor((Date.now() - record.created_at) / 1000)) }] : []];
      }
      if (sql.startsWith('update otp_verifications')) {
        if (sql.includes('where user_id = ?')) {
          for (const otp of state.otps) if (otp.user_id === args[0] && otp.purpose === args[1] && !otp.verified_at) otp.verified_at = Date.now();
        } else {
          const otp = state.otps.find(row => row.id === args[0]);
          if (sql.includes('attempts = attempts + 1')) otp.attempts += 1;
          else if (sql.includes('expires_at = now()')) otp.expires_at = Date.now();
          else otp.verified_at = Date.now();
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('update users')) {
        const passwordUpdate = sql.includes('set password = ?');
        const user = state.users.find(row => row.id === args[passwordUpdate ? 1 : 0]);
        if (!user || (sql.includes('and token_version = ?') && user.token_version !== args[1])) return [{ affectedRows: 0 }];
        if (passwordUpdate) user.password = args[0];
        if (sql.includes('must_change_password = 0')) user.must_change_password = 0;
        if (sql.includes('is_active = 1')) user.is_active = 1;
        if (sql.includes('token_version = token_version + 1')) user.token_version += 1;
        if (sql.includes('countlogin = countlogin + 1')) user.countLogin += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unhandled test SQL: ${sql}`);
    }
  };
  return pool;
}

async function harness(t, options = {}) {
  // Server chỉ nghe trên localhost với cổng tự cấp; email được thu vào mảng để đối chiếu.
  const pool = memoryPool();
  const emails = [];
  const app = express();
  app.use(express.json());
  const config = { ...env, OTP_ENABLED: options.otpEnabled === false ? 'false' : 'true' };
  app.use('/api/auth', createAuthRouter({ pool, env: config, sendOtpEmail: async message => { emails.push(message); return options.mailer?.(message, emails.length); } }));
  app.get('/api/auth/business', createAccess({ pool, env: config }), (request, response) => response.json({ success: true, user: request.user }));
  app.use((_error, _request, response, _next) => response.status(500).json({ success: false, code: 'INTERNAL_ERROR' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  return {
    pool, emails,
    async request(path, body, token) {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json(), retryAfter: response.headers.get('retry-after') };
    }
  };
}

async function activeAccount(api) {
  assert.equal((await api.request('/register', registration)).status, 201);
  assert.equal((await api.request('/verify-registration', { identifier: registration.email, otp: api.emails.at(-1).otp })).status, 200);
  const login = await api.request('/login', { identifier: registration.email, password: registration.password });
  assert.equal(login.status, 200);
  return login.body.token;
}

test('startup rejects weak/missing secrets and production OTP disclosure', () => {
  for (const JWT_SECRET of [undefined, '', 'development-only-secret', 'change-me-before-production-0123456789']) assert.throws(() => validateAuthConfiguration({ ...env, JWT_SECRET }), /JWT_SECRET/);
  assert.throws(() => validateAuthConfiguration({ ...env, NODE_ENV: 'production', OTP_DEV_MODE: 'true' }), /OTP_DEV_MODE/);
  assert.throws(() => validateAuthConfiguration({ ...env, OTP_EXPIRES_MINUTES: '0' }), /OTP_EXPIRES_MINUTES/);
  assert.throws(() => validateAuthConfiguration({ ...env, JWT_EXPIRES_IN: '120' }), /JWT_EXPIRES_IN/);
  assert.equal(validateAuthConfiguration(env).developmentOtp, false);
});

test('limiter enforces account window and permits retry after expiration', () => {
  let time = 0;
  const limiter = createRateLimiter({ now: () => time });
  assert.equal(limiter.consume('login', 'account', 2, 1000).allowed, true);
  assert.equal(limiter.consume('login', 'account', 2, 1000).allowed, true);
  assert.deepEqual(limiter.consume('login', 'account', 2, 1000), { allowed: false, retryAfter: 1 });
  assert.equal(limiter.consume('login', 'another-account', 2, 1000).allowed, true);
  time = 1000;
  assert.equal(limiter.consume('login', 'account', 2, 1000).allowed, true);
});

test('SMTP failure leaves recoverable registration, expires failed OTP, and never discloses provider error', async t => {
  const api = await harness(t, { mailer: (_message, count) => { if (count === 1) throw new Error('private SMTP password/host'); } });
  const failed = await api.request('/register', registration);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.registrationPending, true);
  assert.equal(failed.body.code, 'OTP_DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(failed.body), /private SMTP|password\/host|devOtp/);
  assert.equal(api.pool.state.users[0].is_active, 0);
  const identifier = registration.email;
  assert.equal((await api.request('/verify-registration', { identifier, otp: api.emails[0].otp })).status, 400);
  const resent = await api.request('/resend-registration', { identifier });
  assert.equal(resent.status, 200);
  assert.equal(api.pool.state.users.length, 1);
  assert.equal((await api.request('/verify-registration', { identifier, otp: api.emails[1].otp })).status, 200);
  const login = await api.request('/login', { identifier, password: registration.password });
  assert.equal(login.status, 200);
  assert.equal((await api.request('/me', undefined, login.body.token)).status, 200);
  assert.equal((await api.request('/logout', {}, login.body.token)).status, 200);
  assert.equal((await api.request('/me', undefined, login.body.token)).status, 401);
});

test('registration rolls back account when OTP storage fails', async t => {
  const api = await harness(t);
  api.pool.failOtpInsert = true;
  assert.equal((await api.request('/register', registration)).status, 500);
  assert.equal(api.pool.state.users.length, 0);
  assert.equal(api.emails.length, 0);
  api.pool.failOtpInsert = false;
  assert.equal((await api.request('/register', registration)).status, 201);
});

test('resend cooldown preserves the existing code and concurrent confirmation consumes it once', async t => {
  const api = await harness(t);
  assert.equal((await api.request('/register', registration)).status, 201);
  const identifier = registration.email;
  const cooldown = await api.request('/resend-registration', { identifier });
  assert.equal(cooldown.status, 429);
  assert.ok(Number(cooldown.retryAfter) > 0);
  assert.equal(api.emails.length, 1);
  const results = await Promise.all([api.request('/verify-registration', { identifier, otp: api.emails[0].otp }), api.request('/verify-registration', { identifier, otp: api.emails[0].otp })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(api.pool.state.otps[0].attempts, 1);
});

test('concurrent wrong OTP attempts commit, cap at five, and reject the correct code afterwards', async t => {
  const api = await harness(t);
  await api.request('/register', registration);
  const identifier = registration.email;
  const wrongOtp = api.emails[0].otp === '111111' ? '222222' : '111111';
  const results = await Promise.all(Array.from({ length: 6 }, () => api.request('/verify-registration', { identifier, otp: wrongOtp })));
  assert.ok(results.every(result => result.status === 400));
  assert.equal(api.pool.state.otps[0].attempts, 5);
  assert.equal((await api.request('/verify-registration', { identifier, otp: api.emails[0].otp })).status, 400);
  assert.equal(api.pool.state.users[0].is_active, 0);
});

test('password reset consumes OTP once, revokes old sessions, and preserves a disabled account', async t => {
  const api = await harness(t);
  const token = await activeAccount(api);
  const identifier = registration.email;
  assert.equal((await api.request('/request-password-reset', { identifier })).status, 200);
  const otp = api.emails.at(-1).otp;
  api.pool.state.users[0].is_active = 0;
  assert.equal((await api.request('/me', undefined, token)).status, 401);
  const newPassword = 'ChangedPassword456!';
  const reset = await api.request('/reset-password', { identifier, otp, newPassword });
  assert.equal(reset.status, 200);
  assert.equal(api.pool.state.users[0].is_active, 0);
  assert.equal(await bcrypt.compare(newPassword, api.pool.state.users[0].password), true);
  assert.equal((await api.request('/reset-password', { identifier, otp, newPassword })).status, 400);
  assert.equal((await api.request('/resend-registration', { identifier })).status, 400, 'completed registration cannot reactivate a later blocked account');
  api.pool.state.users[0].is_active = 1;
  assert.equal((await api.request('/me', undefined, token)).status, 401, 'reset revokes the prior token even if account is active again');
  assert.equal((await api.request('/login', { identifier, password: newPassword })).status, 200);
});

test('login is throttled and malformed/legacy tokens and input types are rejected', async t => {
  const api = await harness(t);
  const identifier = registration.email;
  for (let index = 0; index < 5; index++) assert.equal((await api.request('/login', { identifier, password: 'incorrect' })).status, 401);
  const limited = await api.request('/login', { identifier, password: 'incorrect' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(Number(limited.retryAfter) > 0);
  assert.equal((await api.request('/register', { ...registration, email: { malicious: true } })).status, 400);
  assert.equal((await api.request('/register', { ...registration, password: 'á'.repeat(40) })).status, 400, 'bcrypt passwords cannot exceed 72 bytes');
  assert.equal((await api.request('/verify-registration', { identifier, otp: 123456 })).status, 400);
  assert.equal((await api.request('/login', [])).status, 400);
  assert.equal((await api.request('/me')).status, 401);
  assert.equal((await api.request('/me', undefined, 'invalid')).status, 401);
  const legacyToken = jwt.sign({ sub: '1' }, env.JWT_SECRET);
  assert.equal((await api.request('/me', undefined, legacyToken)).status, 401);
});

test('OTP defaults off and public registration cannot grant teacher/admin permissions', async t => {
  assert.equal(validateAuthConfiguration(env).otpEnabled, false);
  const api = await harness(t, { otpEnabled: false, mailer: () => { throw new Error('must never send'); } });
  const registered = await api.request('/register', { ...registration, role: 'admin', permissions: ['reports'], is_active: false });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.registrationPending, false);
  assert.equal(api.pool.state.users[0].role, 'candidate');
  assert.equal(api.pool.state.users[0].is_active, 1);
  assert.equal(api.pool.state.otps.length, 0);
  assert.equal(api.emails.length, 0);
  const login = await api.request('/login', { identifier: registration.dienthoai, password: registration.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'candidate');
  assert.deepEqual(login.body.user.permissions, []);
  assert.doesNotMatch(JSON.stringify(login.body.user), /password_hash|token_version/);
  for (const path of ['/verify-registration', '/resend-registration', '/reset-password']) assert.equal((await api.request(path, { identifier: registration.email, otp: '123456', newPassword: 'Changed123!' })).body.code, 'OTP_DISABLED');
});

test('logout revokes only the current session and access reads current database roles', async t => {
  const api = await harness(t, { otpEnabled: false });
  await api.request('/register', registration);
  const first = (await api.request('/login', { identifier: registration.dienthoai, password: registration.password })).body.token;
  const second = (await api.request('/login', { identifier: registration.dienthoai, password: registration.password })).body.token;
  assert.notEqual(jwt.decode(first).jti, jwt.decode(second).jti);
  assert.equal((await api.request('/logout', {}, first)).status, 200);
  assert.equal((await api.request('/me', undefined, first)).status, 401);
  assert.equal((await api.request('/me', undefined, second)).status, 200);
  api.pool.state.users[0].role = 'teacher';
  api.pool.state.users[0].permissions = JSON.stringify(['questions', 'invented_permission']);
  const fresh = await api.request('/business', undefined, second);
  assert.equal(fresh.body.user.role, 'teacher');
  assert.deepEqual(fresh.body.user.permissions, ['questions']);
  api.pool.state.users[0].is_active = 0;
  assert.equal((await api.request('/me', undefined, second)).status, 401);
});

test('temporary password blocks business access; password change verifies current password and revokes every session', async t => {
  const api = await harness(t, { otpEnabled: false });
  await api.request('/register', registration);
  api.pool.state.users[0].must_change_password = 1;
  const first = (await api.request('/login', { identifier: registration.email, password: registration.password })).body.token;
  const second = (await api.request('/login', { identifier: registration.email, password: registration.password })).body.token;
  assert.equal((await api.request('/business', undefined, first)).body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await api.request('/me', undefined, first)).body.user.must_change_password, true);
  const newPassword = 'ChangedPassword789!';
  assert.equal((await api.request('/change-password', { currentPassword: 'wrong', newPassword }, first)).status, 400);
  assert.equal((await api.request('/change-password', { currentPassword: registration.password, newPassword }, first)).status, 200);
  assert.equal(api.pool.state.users[0].must_change_password, 0);
  assert.equal((await api.request('/me', undefined, first)).status, 401);
  assert.equal((await api.request('/me', undefined, second)).status, 401);
  const next = await api.request('/login', { identifier: registration.email, password: newPassword });
  assert.equal(next.status, 200);
  assert.equal((await api.request('/business', undefined, next.body.token)).status, 200);
  assert.doesNotMatch(JSON.stringify(api.pool.state.audits), /ChangedPassword|StrongPass/);
});

test('forgot password creates a single support request and does not identify missing/disabled users', async t => {
  const api = await harness(t, { otpEnabled: false });
  await api.request('/register', registration);
  api.pool.state.users[0].is_active = 0;
  const oldHash = api.pool.state.users[0].password;
  const [first, second, missing] = await Promise.all([
    api.request('/request-password-reset', { identifier: registration.dienthoai }),
    api.request('/request-password-reset', { identifier: registration.email }),
    api.request('/request-password-reset', { identifier: '0988888888' })
  ]);
  assert.deepEqual(first.body, second.body);
  assert.deepEqual(first.body, missing.body);
  assert.equal(api.pool.state.requests.length, 1);
  assert.equal(api.pool.state.users[0].password, oldHash);
  assert.equal(api.pool.state.users[0].is_active, 0);
  assert.equal(api.emails.length, 0);
});

test('teacher access requires both a named permission and a competition assignment', async () => {
  const pool = memoryPool();
  const teacher = { id: 4, role: 'teacher', permissions: ['questions'] };
  pool.state.assignments.push({ user_id: 4, competition_id: 12 });
  await assertCompetitionAccess(pool, teacher, 12, 'questions');
  await assert.rejects(assertCompetitionAccess(pool, teacher, 13, 'questions'), { status: 403 });
  await assert.rejects(assertCompetitionAccess(pool, teacher, 12, 'reports'), { status: 403 });
  await assert.rejects(assertCompetitionAccess(pool, { ...teacher, role: 'candidate' }, 12, 'questions'), { status: 403 });
  await assertCompetitionAccess(pool, { id: 1, role: 'admin' }, 12, 'reports');
  await assert.rejects(assertCompetitionAccess(pool, { id: 1, role: 'admin' }, 12, 'unknown'), { status: 403 });
});
