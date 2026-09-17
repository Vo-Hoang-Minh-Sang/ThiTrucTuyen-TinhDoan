import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';

// Chỉ chạy khi bật rõ ràng, trên một mysqld tạm được khởi tạo độc lập.
// Xác minh đúng datadir thực tế trước khi tạo database kiểm thử mới có tên riêng.
test('isolated MySQL: migrations, public API and account recovery', {
  skip: process.env.MYSQL_INTEGRATION_TEST !== 'true', timeout: 120000
}, async (context) => {
  const port = Number(process.env.INTEGRATION_MYSQL_PORT);
  const expectedDirectory = process.env.INTEGRATION_MYSQL_DATADIR;
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && port !== 3306, 'use a dedicated high MySQL port');
  assert.ok(expectedDirectory && path.isAbsolute(expectedDirectory) && /tinhdoan-mysql-integration-/.test(expectedDirectory), 'use a dedicated temporary datadir');
  const mysql = (await import('mysql2/promise')).default;
  const probe = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
  try {
    const [[actual]] = await probe.query('SELECT @@datadir AS directory');
    const normalize = (directory) => path.resolve(directory).replaceAll('\\', '/').toLowerCase();
    assert.equal(normalize(actual.directory), normalize(expectedDirectory), 'refuse to mutate an unrelated MySQL instance');
  } finally {
    await probe.end();
  }

  // Đặt đầy đủ cấu hình trước khi import để không dùng nhầm thông tin database trong .env.
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '',
    DB_NAME: `integration_${randomUUID().replaceAll('-', '')}`, NODE_ENV: 'development',
    OTP_ENABLED: 'true', OTP_DEV_MODE: 'false', OTP_EXPIRES_MINUTES: '5',
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_EXPIRES_IN: '2h', CLIENT_URL: 'http://localhost:5173'
  });
  const { initializeDatabase, closeDatabase, pool } = await import('../src/db.js');
  const { createApp } = await import('../src/app.js');
  let server;
  try {
    await initializeDatabase();
    const [[empty]] = await pool.query('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM exams) AS exams, (SELECT COUNT(*) FROM statistics) AS statistics');
    assert.deepEqual(Object.fromEntries(Object.entries(empty).map(([key, value]) => [key, Number(value)])), { users: 0, exams: 0, statistics: 0 });
    // Chỉ sửa database giả lập vừa tạo và còn trống để tái hiện cấu trúc cũ,
    // qua đó kiểm tra lệnh DDL nâng cấp trên MySQL thật.
    const { dataSource } = await import('../src/data-source.js');
    const { InitialSchema1788912000000 } = await import('../src/migrations/1788912000000-InitialSchema.js');
    const upgradeRunner = dataSource.createQueryRunner();
    try {
      await upgradeRunner.query('ALTER TABLE exams DROP FOREIGN KEY fk_exams_round_id, DROP COLUMN round_id');
      await new InitialSchema1788912000000().up(upgradeRunner);
      const upgraded = await upgradeRunner.getTable('exams');
      assert.ok(upgraded.columns.some((column) => column.name === 'round_id'));
      assert.ok(upgraded.foreignKeys.some((key) => key.columnNames.includes('round_id')));
    } finally {
      await upgradeRunner.release();
    }
    await initializeDatabase();
    const [[migration]] = await pool.query('SELECT COUNT(*) AS total FROM schema_migrations');
    assert.equal(Number(migration.total), 3);

    const emails = [];
    // Mô phỏng cả gửi thành công lẫn sự cố SMTP, không gửi email ra ngoài.
    let deliveryFails = false;
    server = createApp({ pool, sendOtpEmail: async (message) => { if (deliveryFails) throw new Error('simulated SMTP outage'); emails.push(message); } }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const request = async (route, body, token) => {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json() };
    };
    const get = async (route) => { const response = await request(route); assert.equal(response.status, 200, route); return response.body.data; };
    assert.equal((await request('/health')).body.database, 'connected');
    assert.deepEqual(await get('/exams'), []);
    const emptyDashboard = await get('/dashboard');
    assert.equal(emptyDashboard.competition, null);
    assert.deepEqual(emptyDashboard.results, []);
    assert.equal(emptyDashboard.statistics.totalRegistrations, 0);

    // Test tự tạo dữ liệu tối thiểu cần thiết, không phụ thuộc dữ liệu mẫu của ứng dụng.
    const [organization] = await pool.query("INSERT INTO doancoso (ten) VALUES ('Đoàn cơ sở kiểm thử')");
    await pool.query("INSERT INTO donvi (ten,doanCoSoID) VALUES ('Đơn vị kiểm thử', ?)", [organization.insertId]);
    const [units] = await pool.query('SELECT id FROM donvi');
    assert.equal(units.length, 1);

    const account = { hoten: 'Kiểm thử MySQL', dienthoai: '0909988776', email: 'integration@example.com', password: 'IntegrationPass123!', donviID: units[0].id };
    deliveryFails = true;
    const failedRegistration = await request('/auth/register', account);
    assert.equal(failedRegistration.status, 503);
    assert.equal(failedRegistration.body.code, 'OTP_DELIVERY_FAILED');
    const [[pending]] = await pool.query('SELECT id, is_active FROM users WHERE email = ?', [account.email]);
    assert.equal(pending.is_active, 0);
    deliveryFails = false;
    assert.equal((await request('/auth/resend-registration', { identifier: account.email })).status, 200);
    assert.equal((await request('/auth/verify-registration', { identifier: account.email, otp: emails.at(-1).otp })).status, 200);
    const login = await request('/auth/login', { identifier: account.email, password: account.password });
    assert.equal(login.status, 200);
    assert.equal((await request('/auth/me', undefined, login.body.token)).status, 200);

    assert.equal((await request('/auth/request-password-reset', { identifier: account.email })).status, 200);
    const reset = { identifier: account.email, otp: emails.at(-1).otp, newPassword: 'ReplacementPass123!' };
    const concurrent = await Promise.all([request('/auth/reset-password', reset), request('/auth/reset-password', reset)]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 400], 'OTP can be consumed only once across concurrent real transactions');
    assert.equal((await request('/auth/me', undefined, login.body.token)).status, 401);
    const relogin = await request('/auth/login', { identifier: account.email, password: reset.newPassword });
    assert.equal(relogin.status, 200);
    assert.equal((await request('/auth/logout', {}, relogin.body.token)).status, 200);
    assert.equal((await request('/auth/me', undefined, relogin.body.token)).status, 401);

    context.diagnostic('Migration trên database trống, đăng ký OTP, thu hồi token và xử lý đồng thời đã đạt mà không cần dữ liệu mẫu.');
  } finally {
    // Luôn đóng server HTTP và kết nối; giữ database kiểm thử để có thể kiểm tra lại.
    if (server) {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
    await closeDatabase();
  }
});
