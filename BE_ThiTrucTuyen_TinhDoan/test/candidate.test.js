import assert from 'node:assert/strict';
import test from 'node:test';
import { rankResults, roundParticipation } from '../src/exam/rounds.js';
import {
  computeDeadline, createCandidateService, finalizeExpiredSessions, gradeAnswers,
  readSnapshot, sessionToPayload, validateAnswers
} from '../src/exam/exam-service.js';

const questions = [
  { id: 1, content: 'Câu một', optionA: 'A1', optionB: 'B1', optionC: 'C1', optionD: 'D1', correctAnswer: 'A', topic: 'Chủ đề', difficulty: 'easy' },
  { id: 2, content: 'Câu hai', optionA: 'A2', optionB: 'B2', optionC: 'C2', optionD: 'D2', correctAnswer: 'C', topic: 'Chủ đề', difficulty: 'medium' }
];
const initialTime = new Date('2026-09-10T01:00:00Z');

test('backend round states cover registration, schedule, qualification, quota and completion', () => {
  const base = { round: {start_datetime:'2026-09-10T00:00:00Z',end_datetime:'2026-09-10T02:00:00Z'}, competition:{start_at:'2026-09-10T00:00:00Z',end_at:'2026-09-10T03:00:00Z',status:'published',max_attempts:2},now:initialTime,registered:true,eligible:true,used:0,completed:0,hasExam:true };
  const state = change => roundParticipation({...base,...change});
  assert.equal(state({}).status,'AVAILABLE');
  for (const change of [{registered:false},{eligible:false},{hasExam:false},{now:new Date('2026-09-09')},{now:new Date('2026-09-10T04:00:00Z')}]) assert.equal(state(change).status,'LOCKED');
  assert.equal(state({used:1,completed:1}).status,'AVAILABLE');
  assert.equal(state({used:2,completed:2}).status,'COMPLETED');
  assert.equal(state({used:2,completed:1,activeSessionId:99,hasExam:false}).status,'AVAILABLE');
  assert.equal(state({completed:1,round:{...base.round,finalized_at:initialTime}}).status,'COMPLETED');
  assert.equal(state({completed:1,competition:{...base.competition,status:'closed'}}).status,'COMPLETED');
  assert.equal(state({used:2,completed:1,activeSessionId:99,competition:{...base.competition,status:'closed'}}).status,'AVAILABLE');
  assert.equal(state({now:new Date('2026-09-09')}).scheduleStatus,'upcoming');
});

test('ranking uses best attempt per candidate, score before time and stable tie breakers', () => {
  const result = (id,user_id,score,duration_seconds,finished_at='2026-09-10T01:30:00Z') => ({id,user_id,score,duration_seconds,finished_at});
  const ranked = rankResults([result(1,1,90,1),result(2,1,100,50),result(3,2,100,10),result(4,3,100,10),result(5,4,100,10,'2026-09-10T01:29:00Z')]);
  assert.deepEqual(ranked.map(row=>row.id),[5,3,4,2]);
  // Khi cùng điểm và thời gian, thời điểm nộp rồi ID thí sinh giữ thứ tự ổn định.
  assert.deepEqual(rankResults([result(11,11,100,20), result(12,12,100,20), result(13,13,80,20)]).map(row => row.id), [11, 12, 13]);
});

// Pool thử nghiệm thực hiện commit/rollback và tuần tự hóa giao dịch để kiểm tra luồng nghiệp vụ đồng thời.
// Khóa hàng thực tế vẫn cần kiểm tra bổ sung bằng MySQL tích hợp.
function fixture({ maxAttempts = 1, endAt = '2026-09-10T02:00:00Z', registered = true } = {}) {
  let state = {
    now: initialTime, users: [{ id: 1, donviID: 9 }, { id: 2, donviID: 10 }], sessions: [], registrations: registered ? [{ user_id: 1, competition_id: 7, unit_id: 9, registered_at: initialTime }] : [], results: [],
    competition: { id: 7, name: 'Kỳ thi', description: '', duration_minutes: 30, max_attempts: maxAttempts,
      start_at: new Date('2026-09-10T00:00:00Z'), end_at: new Date(endAt), status: 'published' },
    exams: [{ id: 5, name: 'Đề một', code: 'DE001', question_snapshot: structuredClone(questions) }]
  };
  const matches = (a, b) => String(a) === String(b);
  const query = async (sql, args = []) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (sql === 'SELECT CURRENT_TIMESTAMP AS server_now') return [[{ server_now: state.now }]];
    if (sql.startsWith('SELECT id, donviID FROM users')) return [state.users.filter(user => matches(user.id, args[0]))];
    if (sql.startsWith('SELECT * FROM rounds')) return [[]];
    if (sql.startsWith('SELECT * FROM competitions')) return [matches(state.competition.id, args[0]) ? [state.competition] : []];
    if (sql.includes('FROM user_exam_sessions WHERE user_id = ? AND competition_id = ? AND status')) {
      return [structuredClone(state.sessions.filter(session => matches(session.user_id, args[0]) && matches(session.competition_id, args[1]) && session.status === 'in_progress').reverse())];
    }
    if (sql.startsWith('SELECT COUNT(*) AS used')) return [[{ used: state.sessions.filter(session => matches(session.user_id, args[0]) && matches(session.competition_id, args[1])).length }]];
    if (sql.startsWith('SELECT id FROM exams')) return [state.exams.map(({ id }) => ({ id }))];
    if (sql.startsWith('SELECT id, name, code, question_snapshot FROM exams')) return [state.exams.filter(item => matches(item.id, args[0]))];
    if (sql.startsWith('INSERT INTO competition_registrations')) {
      if (!state.registrations.some(item => matches(item.user_id, args[0]) && matches(item.competition_id, args[1]))) {
        state.registrations.push({ user_id: args[0], competition_id: args[1], unit_id: args[2], registered_at: state.now });
      }
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT registered_at FROM competition_registrations')) return [state.registrations.filter(item => matches(item.user_id, args[0]) && matches(item.competition_id, args[1]))];
    if (sql.startsWith('INSERT INTO user_exam_sessions')) {
      const session = { id: state.sessions.length + 1, user_id: args[0], exam_id: args[1], competition_id: args[2], question_ids: JSON.parse(args[3]),
        question_snapshot: JSON.parse(args[4]), answers: JSON.parse(args[5]), started_at: args[6], expires_at: args[7], status: 'in_progress', revision: 0,
        attempt_number: args[8], updated_at: args[9], score: null, finished_at: null };
      state.sessions.push(session);
      return [{ insertId: session.id, affectedRows: 1 }];
    }
    if (sql.includes('FROM user_exam_sessions WHERE id = ?')) return [structuredClone(state.sessions.filter(item => matches(item.id, args[0]) && (args.length === 1 || matches(item.user_id, args[1]))))];
    if (sql.startsWith('SELECT c.name AS competitionName')) {
      const exam = state.exams.find(item => matches(item.id, args[1]));
      return [[{ competitionName: state.competition.name, examName: exam.name, examCode: exam.code }]];
    }
    if (sql.startsWith('UPDATE user_exam_sessions SET answers')) {
      const session = state.sessions.find(item => matches(item.id, args[2]));
      session.answers = JSON.parse(args[0]); session.updated_at = args[1];
      if (sql.includes('revision = revision + 1')) session.revision += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE user_exam_sessions SET score')) {
      Object.assign(state.sessions.find(item => matches(item.id, args[5])), { score: args[0], finished_at: args[1], status: args[2], revision: args[3], updated_at: args[4] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO results')) {
      if (state.results.some(item => matches(item.session_id, args[2]))) throw Object.assign(new Error('Duplicate result'), { code: 'ER_DUP_ENTRY' });
      state.results.push({ id: state.results.length + 1, user_id: args[0], exam_id: args[1], session_id: args[2], score: args[3], finished_at: args[4] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, user_id FROM user_exam_sessions')) {
      return [state.sessions.filter(item => item.status === 'in_progress' && item.expires_at <= state.now).map(({ id, user_id }) => ({ id, user_id }))];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  let pending = Promise.resolve();
  const pool = {
    query,
    transaction(callback) {
      const current = pending.then(async () => {
        const before = structuredClone(state);
        try { return await callback({ query }); } catch (error) { state = before; throw error; }
      });
      pending = current.catch(() => {});
      return current;
    }
  };
  return { pool, service: createCandidateService({ pool, randomIndex: () => 0 }), get state() { return state; } };
}

test('deadline uses server duration and clips at the competition closing instant', () => {
  assert.equal(computeDeadline(initialTime, 30, new Date('2026-09-10T03:00:00Z')).toISOString(), '2026-09-10T01:30:00.000Z');
  assert.equal(computeDeadline(initialTime, 30, new Date('2026-09-10T01:05:00Z')).toISOString(), '2026-09-10T01:05:00.000Z');
  assert.throws(() => computeDeadline(initialTime, 30, initialTime), { code: 'INVALID_SCHEDULE' });
  assert.throws(() => computeDeadline(initialTime, 0, new Date('2026-09-11')), { code: 'INVALID_SCHEDULE' });
});

test('only answers to snapshot questions are accepted and blank selections can be removed', () => {
  assert.deepEqual(validateAnswers({ 1: 'B', 2: 'C' }, questions), { 1: 'B', 2: 'C' });
  assert.deepEqual(validateAnswers({}, questions), {});
  for (const answers of [null, [], { 3: 'A' }, { 1: 'a' }, { 1: null }, { 1: { correctAnswer: 'A' } }]) {
    assert.throws(() => validateAnswers(answers, questions), { code: 'INVALID_ANSWERS' });
  }
  assert.equal(gradeAnswers(questions, {}), 0);
  assert.equal(gradeAnswers(questions, { 1: 'A' }), 50);
  assert.equal(gradeAnswers(questions, { 1: 'A', 2: 'C' }), 100);
  assert.equal(gradeAnswers([...questions, { ...questions[0], id: 3 }], { 1: 'A' }), 33.33);
});

test('invalid or duplicate snapshot questions are rejected and payload never exposes answer keys', () => {
  assert.throws(() => readSnapshot([]), { code: 'INVALID_EXAM' });
  assert.throws(() => readSnapshot([questions[0], questions[0]]), { code: 'INVALID_EXAM' });
  const payload = sessionToPayload({ id: 1, competition_id: 7, exam_id: 5, question_snapshot: JSON.stringify(questions), answers: '{}', revision: '0',
    started_at: initialTime, expires_at: new Date('2026-09-10T01:30:00Z'), status: 'in_progress', score: null, attempt_number: 1 }, {}, initialTime);
  assert.deepEqual(Object.keys(payload.questions[0]), ['id', 'content', 'optionA', 'optionB', 'optionC', 'optionD']);
  assert.equal(JSON.stringify(payload).includes('correctAnswer'), false);
  assert.equal(payload.score, null);
});

test('start requires separate registration for the same candidate and competition without consuming attempts', async () => {
  const f = fixture({ registered: false });
  await assert.rejects(() => f.service.start(1, 7), { status: 403, code: 'REGISTRATION_REQUIRED' });
  assert.equal(f.state.sessions.length, 0);
  assert.equal(f.state.registrations.length, 0);
  await f.service.register(2, 7);
  await assert.rejects(() => f.service.start(1, 7), { code: 'REGISTRATION_REQUIRED' });
  await f.service.register(1, 7);
  await assert.rejects(() => f.service.start(1, 8), { code: 'REGISTRATION_REQUIRED' });
  const session = await f.service.start(1, 7);
  assert.equal(session.attemptNumber, 1);
});

test('parallel starts restore one session and count one registration and one attempt', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.start(1, 7), f.service.start(1, 7)]);
  assert.equal(a.id, b.id);
  assert.equal(a.attemptNumber, 1);
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.registrations.length, 1);
  assert.equal(f.state.registrations[0].unit_id, 9);
  f.state.users[0].donviID = 15;
  await f.service.register(1, 7);
  assert.equal(f.state.registrations[0].unit_id, 9);
});

test('parallel saves detect stale revisions and provide the authoritative copy without keys', async () => {
  const f = fixture();
  const session = await f.service.start(1, 7);
  const results = await Promise.allSettled([
    f.service.save(1, session.id, { answers: { 1: 'A' }, revision: 0 }),
    f.service.save(1, session.id, { answers: { 2: 'C' }, revision: 0 })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const error = results.find(result => result.status === 'rejected').reason;
  assert.equal(error.status, 409);
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.deepEqual(error.item.answers, { 1: 'A' });
  assert.equal(JSON.stringify(error.item).includes('correctAnswer'), false);
  const cleared = await f.service.save(1, session.id, { answers: {}, revision: error.item.revision });
  assert.deepEqual(cleared.answers, {});
});

test('parallel submit is idempotent and a finished attempt consumes its quota', async () => {
  const f = fixture();
  const session = await f.service.start(1, 7);
  const [first, repeated] = await Promise.all([
    f.service.submit(1, session.id, { answers: { 1: 'A', 2: 'C' }, revision: 0 }),
    f.service.submit(1, session.id, { answers: {}, revision: 0 })
  ]);
  assert.equal(first.score, 100);
  assert.deepEqual(first, repeated);
  assert.equal(f.state.results.length, 1);
  await assert.rejects(() => f.service.start(1, 7), { status: 409, code: 'ATTEMPT_LIMIT' });
  assert.equal(f.state.sessions.length, 1);
});

test('a user cannot restore, save or submit another candidate session', async () => {
  const f = fixture();
  const session = await f.service.start(1, 7);
  await assert.rejects(() => f.service.session(2, session.id), { status: 404 });
  await assert.rejects(() => f.service.save(2, session.id, { answers: {}, revision: 0 }), { status: 404 });
  await assert.rejects(() => f.service.submit(2, session.id), { status: 404 });
  assert.equal(f.state.sessions[0].status, 'in_progress');
});

test('deadline rejects late answers and grades only progress saved on time', async () => {
  for (const action of ['save', 'submit']) {
    const f = fixture();
    const session = await f.service.start(1, 7);
    await f.service.save(1, session.id, { answers: { 1: 'A' }, revision: 0 });
    f.state.now = new Date(session.expiresAt);
    const final = await f.service[action](1, session.id, { answers: { 1: 'A', 2: 'C' }, revision: 1 });
    assert.equal(final.status, 'expired');
    assert.equal(final.score, 50);
    assert.deepEqual(final.answers, { 1: 'A' });
    assert.equal(f.state.results[0].finished_at.toISOString(), session.expiresAt);
  }
});

test('background expiration grades closed browsers and does not create duplicate results', async () => {
  const f = fixture();
  const session = await f.service.start(1, 7);
  await f.service.save(1, session.id, { answers: { 1: 'A' }, revision: 0 });
  f.state.now = new Date(new Date(session.expiresAt).getTime() + 60_000);
  const batches = await Promise.all([finalizeExpiredSessions(f.pool), finalizeExpiredSessions(f.pool)]);
  assert.equal(batches.reduce((count, item) => count + item.processed, 0), 1);
  assert.equal(f.state.results.length, 1);
  assert.equal(f.state.results[0].score, 50);
  assert.equal(f.state.sessions[0].status, 'expired');
});

test('expired session commits its result even when a request for another attempt is rejected', async () => {
  const f = fixture();
  const session = await f.service.start(1, 7);
  f.state.now = new Date(session.expiresAt);
  await assert.rejects(() => f.service.start(1, 7), { code: 'ATTEMPT_LIMIT' });
  assert.equal(f.state.sessions[0].status, 'expired');
  assert.equal(f.state.results.length, 1);
});

test('each new attempt receives an immutable snapshot and the next attempt number', async () => {
  const f = fixture({ maxAttempts: 2, endAt: '2026-09-10T01:05:00Z' });
  const first = await f.service.start(1, 7);
  assert.equal(first.expiresAt, '2026-09-10T01:05:00.000Z');
  f.state.exams[0].question_snapshot[0].correctAnswer = 'B';
  f.state.exams[0].question_snapshot[0].content = 'Nội dung mới';
  const restored = await f.service.session(1, first.id);
  assert.equal(restored.questions[0].content, 'Câu một');
  const submitted = await f.service.submit(1, first.id, { answers: { 1: 'A' }, revision: 0 });
  assert.equal(submitted.score, 50);
  const second = await f.service.start(1, 7);
  assert.equal(second.attemptNumber, 2);
  assert.equal(second.questions[0].content, 'Nội dung mới');
});
