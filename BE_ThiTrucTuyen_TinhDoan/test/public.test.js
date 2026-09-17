// Kiểm thử lịch thi, dữ liệu rỗng và định dạng dashboard qua bộ truy vấn giả lập.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createPublicRouter, examToPayload } from '../src/exam/public.js';

async function serve(t, pool) {
  // Mỗi ca kiểm thử tự cấp cổng localhost và đóng server khi hoàn tất.
  const app = express();
  app.use('/api', createPublicRouter({ pool }));
  app.use((_error, _request, response, _next) => response.status(500).json({ success: false }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api`;
}

test('exam schedules distinguish missing, upcoming, active and ended dates', () => {
  const exam = { id: 1, title: 'Đề thi', questions: '0', takingtime: 15, passingscore: '50.00' };
  assert.equal(examToPayload(exam).status, 'Chưa có lịch thi');
  const scheduled = { ...exam, start_datetime: '2026-09-10T08:00:00+07:00', end_datetime: '2026-09-10T09:00:00+07:00' };
  assert.equal(examToPayload(scheduled, new Date('2026-09-10T07:59:59+07:00')).status, 'Sắp diễn ra');
  assert.equal(examToPayload(scheduled, new Date('2026-09-10T08:30:00+07:00')).status, 'Đang diễn ra');
  assert.equal(examToPayload(scheduled, new Date('2026-09-10T09:00:01+07:00')).status, 'Đã kết thúc');
  assert.equal(examToPayload({ ...scheduled, end_datetime: 'invalid' }).status, 'Chưa có lịch thi');
});

test('date-only competition includes the whole final day for strings and MySQL Date objects', () => {
  for (const dates of [{ start_date: '2026-09-09', end_date: '2026-09-10' }, { start_date: new Date(2026, 8, 9), end_date: new Date(2026, 8, 10) }]) {
    const result = examToPayload({ ...dates, questions: '0' }, new Date(2026, 8, 10, 22));
    assert.equal(result.status, 'Đang diễn ra');
    assert.equal(result.questions, 0);
    assert.equal(new Date(result.endAt).getHours(), 23);
  }
});

test('health checks current database availability on every request', async t => {
  let available = true;
  const base = await serve(t, { query: async () => { if (!available) throw new Error('disconnected'); return [[{ 1: 1 }]]; } });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  available = false;
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).database, 'disconnected');
});

test('empty database produces empty exams/dashboard and actual zero totals', async t => {
  const base = await serve(t, { query: async sql => sql.includes('AS totalRegistrations,') && sql.includes('SELECT (SELECT') ? [[{ totalRegistrations: '0', totalTests: '0' }]] : [[]] });
  assert.deepEqual((await (await fetch(`${base}/exams`)).json()).data, []);
  const { data } = await (await fetch(`${base}/dashboard`)).json();
  assert.equal(data.competition, null);
  assert.deepEqual(data.rounds, []);
  assert.deepEqual(data.results, []);
  assert.deepEqual(data.statistics, { totalRegistrations: 0, totalTests: 0, units: [] });
});

test('dashboard exposes result records separately from exams with null duration preserved', async t => {
  const base = await serve(t, { query: async sql => {
    if (sql.includes('FROM competitions')) return [[{ id: 7, name: 'Cuộc thi', status: 'published', start_date: '2026-09-01', end_date: '2026-09-30' }]];
    if (sql.includes('FROM rounds WHERE')) return [[{ id: 1, round_number: 1, start_datetime: new Date(2026, 8, 1), end_datetime: new Date(2026, 8, 30) }]];
    if (sql.includes('FROM results r JOIN users u ON u.id = r.user_id JOIN exams')) return [[{ id: 3, fullName: 'Thí sinh thử nghiệm', unitName: 'Đơn vị', organizationName: 'Đoàn', score: '85.00', durationSeconds: null, finishedAt: new Date(2026, 8, 9) }]];
    if (sql.includes('SELECT (SELECT')) return [[{ totalRegistrations: '1', totalTests: '1' }]];
    return [[{ id: 1, name: 'Đơn vị', organizationName: 'Đoàn', totalRegistrations: '1', totalTests: '1' }]];
  } });
  const { data } = await (await fetch(`${base}/dashboard`)).json();
  assert.equal(data.results[0].fullName, 'Thí sinh thử nghiệm');
  assert.equal(data.results[0].score, 85);
  assert.equal(data.results[0].durationSeconds, null);
  assert.equal(data.statistics.units[0].totalTests, 1);
});

test('dashboard statistics only count registrations and attempts of the displayed competition', async t => {
  const statisticParams = [];
  const base = await serve(t, { query: async (sql, values = []) => {
    if (sql.includes('FROM competitions')) return [[{ id: 42, name: 'Kỳ thi được ghim', status: 'published', start_date: '2026-09-01', end_date: '2026-09-30' }]];
    if (sql.includes('FROM rounds WHERE')) return [[]];
    if (sql.includes('SELECT r.id, u.hoten')) return [[]];
    if (sql.includes('SELECT\n        (SELECT COUNT(*) FROM competition_registrations')) { statisticParams.push(values); return [[{ totalRegistrations: '2', totalTests: '7' }]]; }
    if (sql.includes('FROM donvi d')) { statisticParams.push(values); return [[]]; }
    return [[]];
  } });
  const { data } = await (await fetch(`${base}/dashboard`)).json();
  assert.deepEqual(data.statistics, { totalRegistrations: 2, totalTests: 7, units: [] });
  assert.deepEqual(statisticParams, [[42, 42], [42, 42]]);
});
