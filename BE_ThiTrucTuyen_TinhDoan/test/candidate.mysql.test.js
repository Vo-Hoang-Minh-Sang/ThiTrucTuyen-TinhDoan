import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { createCandidateService, finalizeExpiredSessions } from '../src/exam-service.js';

// Chỉ thử trên mysqld tạm có datadir được xác minh; không đọc hay sửa database thật trong .env.
test('isolated MySQL: concurrent attempts, saves, submissions and expiration', {
  skip: process.env.MYSQL_INTEGRATION_TEST !== 'true', timeout: 120_000
}, async () => {
  const port = Number(process.env.INTEGRATION_MYSQL_PORT);
  const expectedDirectory = process.env.INTEGRATION_MYSQL_DATADIR;
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && port !== 3306);
  assert.ok(expectedDirectory && path.isAbsolute(expectedDirectory) && /tinhdoan-mysql-integration-/.test(expectedDirectory));
  const mysql = (await import('mysql2/promise')).default;
  const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
  const database = `candidate_integration_${randomUUID().replaceAll('-', '')}`;
  try {
    const [[actual]] = await connection.query('SELECT @@datadir AS directory');
    const normalize = directory => path.resolve(directory).replaceAll('\\', '/').toLowerCase();
    assert.equal(normalize(actual.directory), normalize(expectedDirectory), 'refuse unrelated database server');
    await connection.query(`CREATE DATABASE ${mysql.escapeId(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally { await connection.end(); }

  const { DataSource } = await import('typeorm');
  const { InitialSchema1788912000000 } = await import('../src/migrations/1788912000000-InitialSchema.js');
  const { ExamPlatform1789000000000 } = await import('../src/migrations/1789000000000-ExamPlatform.js');
  const source = new DataSource({
    type: 'mysql', host: '127.0.0.1', port, username: 'root', password: '', database,
    entities: [], migrations: [InitialSchema1788912000000, ExamPlatform1789000000000],
    migrationsTableName: 'schema_migrations', migrationsTransactionMode: 'none', synchronize: false, logging: false
  });
  try {
    await source.initialize();
    await source.runMigrations({ transaction: 'none' });
    const pool = {
      async query(...args) { return [await source.query(...args)]; },
      transaction(callback) { return source.transaction(manager => callback({ async query(...args) { return [await manager.query(...args)]; } })); }
    };
    const service = createCandidateService({ pool });
    const [user] = await pool.query("INSERT INTO users (hoten, dienthoai, email, password, is_active, role) VALUES ('Thí sinh kiểm thử', '0909999901', 'candidate-test@example.invalid', 'unused', 1, 'candidate')");
    const [otherUser] = await pool.query("INSERT INTO users (hoten, dienthoai, email, password, is_active, role) VALUES ('Thí sinh khác', '0909999902', 'candidate-other@example.invalid', 'unused', 1, 'candidate')");
    const [competition] = await pool.query(`INSERT INTO competitions (name, start_date, end_date, start_at, end_at, status, duration_minutes, max_attempts)
      VALUES ('Kỳ thi kiểm thử', CURDATE(), CURDATE(), DATE_SUB(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR), 'published', 30, 2)`);
    const questions = [
      { id: 101, content: 'Câu một', optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A' },
      { id: 102, content: 'Câu hai', optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'C' }
    ];
    await pool.query(`INSERT INTO exams (name, competition_id, code, question_snapshot, is_published)
      VALUES ('Đề kiểm thử', ?, 'TEST001', ?, 1)`, [competition.insertId, JSON.stringify(questions)]);
    const starts = await Promise.all(Array.from({ length: 8 }, () => service.start(user.insertId, competition.insertId)));
    const sessionId = starts[0].id;
    assert.equal(new Set(starts.map(item => String(item.id))).size, 1);
    const [[counts]] = await pool.query(`SELECT (SELECT COUNT(*) FROM user_exam_sessions) AS sessions,
      (SELECT COUNT(*) FROM competition_registrations) AS registrations`);
    assert.equal(Number(counts.sessions), 1);
    assert.equal(Number(counts.registrations), 1);
    assert.equal(JSON.stringify(starts).includes('correctAnswer'), false);

    const writes = await Promise.allSettled([
      service.save(user.insertId, sessionId, { answers: { 101: 'A' }, revision: 0 }),
      service.save(user.insertId, sessionId, { answers: { 102: 'C' }, revision: 0 })
    ]);
    assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(writes.find(item => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    await assert.rejects(() => service.session(otherUser.insertId, sessionId), { status: 404 });
    const saved = await service.session(user.insertId, sessionId);
    const submitted = await Promise.all(Array.from({ length: 8 }, () => service.submit(user.insertId, sessionId, { answers: { 101: 'A', 102: 'C' }, revision: saved.revision })));
    assert.ok(submitted.every(item => item.status === 'submitted' && item.score === 100));
    const [[oneResult]] = await pool.query('SELECT COUNT(*) AS total FROM results WHERE session_id = ?', [sessionId]);
    assert.equal(Number(oneResult.total), 1);

    const second = await service.start(user.insertId, competition.insertId);
    assert.equal(second.attemptNumber, 2);
    await service.save(user.insertId, second.id, { answers: { 101: 'A' }, revision: 0 });
    await pool.query('UPDATE user_exam_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [second.id]);
    const expirationRace = await Promise.all([
      service.submit(user.insertId, second.id, { answers: { 101: 'A', 102: 'C' }, revision: 1 }),
      finalizeExpiredSessions(pool),
      finalizeExpiredSessions(pool)
    ]);
    assert.equal(expirationRace[0].status, 'expired');
    assert.equal(expirationRace[0].score, 50);
    assert.equal(expirationRace[1].failed + expirationRace[2].failed, 0);
    await assert.rejects(() => service.start(user.insertId, competition.insertId), { code: 'ATTEMPT_LIMIT' });
    const results = await service.results(user.insertId, String(competition.insertId));
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(item => item.score).sort((a, b) => a - b), [50, 100]);
    assert.deepEqual(await service.results(otherUser.insertId), []);

    // Bài hết hạn phải được ghi kết quả ngay cả khi yêu cầu bắt đầu lượt mới bị từ chối.
    const otherSession = await service.start(otherUser.insertId, competition.insertId);
    await pool.query('UPDATE competitions SET max_attempts = 1 WHERE id = ?', [competition.insertId]);
    await pool.query('UPDATE user_exam_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [otherSession.id]);
    await assert.rejects(() => service.start(otherUser.insertId, competition.insertId), { code: 'ATTEMPT_LIMIT' });
    assert.equal((await service.results(otherUser.insertId)).length, 1);
  } finally { if (source.isInitialized) await source.destroy(); }
});
