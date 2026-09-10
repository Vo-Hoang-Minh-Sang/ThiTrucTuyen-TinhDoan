import { randomInt } from 'node:crypto';

const choices = new Set(['A', 'B', 'C', 'D']);
const sessionColumns = `id, user_id, exam_id, competition_id, question_snapshot, answers,
  revision, started_at, expires_at, status, score, finished_at, attempt_number`;

export function examError(status, message, code, item) {
  return Object.assign(new Error(message), { status, code, ...(item ? { item } : {}) });
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function date(value) {
  if (!value) return null;
  const result = value instanceof Date ? value : new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function iso(value) { return date(value)?.toISOString() ?? null; }

// Chỉ sử dụng bản chụp đề đã lưu, để việc sửa ngân hàng câu hỏi không đổi bài đang thi.
export function readSnapshot(value) {
  const questions = parseJson(value);
  if (!Array.isArray(questions) || !questions.length || questions.length > 500) {
    throw examError(409, 'Đề thi chưa có nội dung hợp lệ. Vui lòng liên hệ quản trị viên.', 'INVALID_EXAM');
  }
  const ids = new Set();
  for (const question of questions) {
    const key = String(question?.id);
    if (!/^\d+$/.test(key) || ids.has(key) || !choices.has(question.correctAnswer)
      || !['content', 'optionA', 'optionB', 'optionC', 'optionD'].every(field => typeof question[field] === 'string' && question[field].trim())) {
      throw examError(409, 'Nội dung đề thi không hợp lệ. Vui lòng liên hệ quản trị viên.', 'INVALID_EXAM');
    }
    ids.add(key);
  }
  return questions;
}

// Đáp án được gửi dưới dạng toàn bộ bản đồ lựa chọn; bỏ khóa tương ứng để xóa lựa chọn.
export function validateAnswers(value, questions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw examError(400, 'Danh sách đáp án không hợp lệ.', 'INVALID_ANSWERS');
  }
  const ids = new Set(questions.map(question => String(question.id)));
  const entries = Object.entries(value);
  if (entries.length > ids.size || entries.some(([id, answer]) => !ids.has(id) || !choices.has(answer))) {
    throw examError(400, 'Đáp án phải thuộc câu hỏi trong bài và có giá trị A, B, C hoặc D.', 'INVALID_ANSWERS');
  }
  return Object.fromEntries(entries);
}

// Mỗi câu có trọng số như nhau; câu bỏ trống hoặc trả lời sai được tính 0 điểm.
export function gradeAnswers(questions, answers) {
  const correct = questions.reduce((count, question) => count + Number(answers[String(question.id)] === question.correctAnswer), 0);
  return Math.round(correct * 10000 / questions.length) / 100;
}

export function computeDeadline(startedAt, durationMinutes, closesAt) {
  const start = date(startedAt);
  const end = date(closesAt);
  const duration = Number(durationMinutes);
  if (!start || !end || !Number.isInteger(duration) || duration < 1 || end <= start) {
    throw examError(409, 'Kỳ thi chưa có lịch hoặc thời lượng hợp lệ.', 'INVALID_SCHEDULE');
  }
  return new Date(Math.min(start.getTime() + duration * 60_000, end.getTime()));
}

export function sessionToPayload(session, details, now) {
  const questions = readSnapshot(session.question_snapshot);
  return {
    id: session.id, competitionId: session.competition_id, competitionName: details.competitionName,
    examId: session.exam_id, examName: details.examName, examCode: details.examCode,
    // Liệt kê rõ trường công khai, tuyệt đối không đưa khóa đáp án hoặc dữ liệu phân loại ra trình duyệt.
    questions: questions.map(({ id, content, optionA, optionB, optionC, optionD }) => ({ id, content, optionA, optionB, optionC, optionD })),
    answers: validateAnswers(parseJson(session.answers) ?? {}, questions),
    revision: Number(session.revision), startedAt: iso(session.started_at), expiresAt: iso(session.expires_at),
    serverNow: iso(now), status: session.status, score: session.score === null || session.score === undefined ? null : Number(session.score),
    attemptNumber: Number(session.attempt_number)
  };
}

async function serverTime(tx) {
  const [[row]] = await tx.query('SELECT CURRENT_TIMESTAMP AS server_now');
  const now = date(row?.server_now);
  if (!now) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
  return now;
}

async function detailsFor(tx, session) {
  const [[details]] = await tx.query(`SELECT c.name AS competitionName, e.name AS examName, e.code AS examCode
    FROM exams e JOIN competitions c ON c.id = ? WHERE e.id = ?`, [session.competition_id, session.exam_id]);
  if (!details) throw examError(404, 'Không tìm thấy kỳ thi hoặc đề thi của bài làm.', 'NOT_FOUND');
  return details;
}

async function payloadFor(tx, session, now) {
  return sessionToPayload(session, await detailsFor(tx, session), now);
}

async function lockUser(tx, userId) {
  const [[user]] = await tx.query('SELECT id, donviID FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!user) throw examError(401, 'Tài khoản không còn tồn tại.', 'UNAUTHORIZED');
  return user;
}

async function registrationFor(tx, user, competitionId) {
  // Khóa tài khoản trước khi gọi hàm này để hai yêu cầu đồng thời không tạo hai lượt đăng ký.
  await tx.query(`INSERT INTO competition_registrations (user_id, competition_id, unit_id)
    VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id`, [user.id, competitionId, user.donviID ?? null]);
  const [[registration]] = await tx.query(`SELECT registered_at FROM competition_registrations
    WHERE user_id = ? AND competition_id = ?`, [user.id, competitionId]);
  return { competitionId, registered: true, registeredAt: iso(registration.registered_at) };
}

async function lockSession(tx, sessionId, userId) {
  const [rows] = await tx.query(`SELECT ${sessionColumns} FROM user_exam_sessions
    WHERE id = ?${userId === undefined ? '' : ' AND user_id = ?'} FOR UPDATE`, userId === undefined ? [sessionId] : [sessionId, userId]);
  if (!rows[0]) throw examError(404, 'Không tìm thấy bài làm.', 'NOT_FOUND');
  return rows[0];
}

function isExpired(session, now) {
  return session.status === 'in_progress' && date(session.expires_at) && date(session.expires_at) <= now;
}

async function finishSession(tx, session, now, expired = false) {
  if (session.status !== 'in_progress') return session;
  const questions = readSnapshot(session.question_snapshot);
  const answers = validateAnswers(parseJson(session.answers) ?? {}, questions);
  const score = gradeAnswers(questions, answers);
  const finishedAt = expired ? date(session.expires_at) : now;
  const status = expired ? 'expired' : 'submitted';
  const revision = Number(session.revision) + 1;
  // Khóa phiên và khóa duy nhất results.session_id đảm bảo nộp lặp chỉ có một kết quả.
  await tx.query(`UPDATE user_exam_sessions SET score = ?, finished_at = ?, status = ?, revision = ?, updated_at = ?
    WHERE id = ?`, [score, finishedAt, status, revision, now, session.id]);
  await tx.query(`INSERT INTO results (user_id, exam_id, session_id, score, finished_at)
    VALUES (?, ?, ?, ?, ?)`, [session.user_id, session.exam_id, session.id, score, finishedAt]);
  return { ...session, score, finished_at: finishedAt, status, revision };
}

function validRevision(value) { return Number.isSafeInteger(value) && value >= 0; }

function competitionPayload(row, now) {
  const start = date(row.start_at);
  const end = date(row.end_at);
  const scheduled = start && end && end > start;
  const used = Number(row.attemptsUsed ?? 0);
  return {
    id: row.id, name: row.name, description: row.description,
    startAt: iso(start), endAt: iso(end), durationMinutes: Number(row.duration_minutes), maxAttempts: Number(row.max_attempts),
    attemptsUsed: used, attemptsRemaining: Math.max(0, Number(row.max_attempts) - used),
    registered: Number(row.registered) > 0, activeSessionId: row.activeSessionId ?? null,
    status: !scheduled ? 'unscheduled' : now < start ? 'upcoming' : now >= end ? 'ended' : 'active'
  };
}

// Mọi quyết định về hạn thi lấy giờ của database, không tin đồng hồ hoặc điểm số từ trình duyệt.
export function createCandidateService({ pool, randomIndex = randomInt }) {
  return {
    async competitions(userId, { from, to } = {}) {
      const now = await serverTime(pool);
      const filters = ["c.status = 'published'"];
      const params = [userId, userId, userId, now];
      if (from) { filters.push('c.end_at >= ?'); params.push(from); }
      if (to) { filters.push('c.start_at < ?'); params.push(to); }
      const [rows] = await pool.query(`SELECT c.*,
        (SELECT COUNT(*) FROM user_exam_sessions s WHERE s.user_id = ? AND s.competition_id = c.id) AS attemptsUsed,
        (SELECT COUNT(*) FROM competition_registrations cr WHERE cr.user_id = ? AND cr.competition_id = c.id) AS registered,
        (SELECT s.id FROM user_exam_sessions s WHERE s.user_id = ? AND s.competition_id = c.id
          AND s.status = 'in_progress' AND s.expires_at > ? ORDER BY s.id DESC LIMIT 1) AS activeSessionId
        FROM competitions c WHERE ${filters.join(' AND ')} ORDER BY c.start_at DESC, c.id DESC`, params);
      return rows.map(row => competitionPayload(row, now));
    },

    async register(userId, competitionId) {
      return pool.transaction(async tx => {
        const user = await lockUser(tx, userId);
        const [[competition]] = await tx.query('SELECT * FROM competitions WHERE id = ? FOR SHARE', [competitionId]);
        const now = await serverTime(tx);
        if (!competition || competition.status !== 'published') throw examError(404, 'Không tìm thấy kỳ thi đã xuất bản.', 'NOT_FOUND');
        if (date(competition.end_at) && now >= date(competition.end_at)) throw examError(409, 'Kỳ thi đã kết thúc đăng ký.', 'REGISTRATION_CLOSED');
        return registrationFor(tx, user, competitionId);
      });
    },

    async start(userId, competitionId) {
      const outcome = await pool.transaction(async tx => {
        const user = await lockUser(tx, userId);
        // Khóa tài khoản tuần tự hóa cả việc kiểm tra số lượt và tạo phiên, kể cả mở nhiều tab cùng lúc.
        const [active] = await tx.query(`SELECT ${sessionColumns} FROM user_exam_sessions
          WHERE user_id = ? AND competition_id = ? AND status = 'in_progress' ORDER BY id DESC FOR UPDATE`, [userId, competitionId]);
        let now = await serverTime(tx);
        let finalized = false;
        for (const session of active) {
          if (isExpired(session, now)) { await finishSession(tx, session, now, true); finalized = true; }
          else return payloadFor(tx, session, now);
        }
        try {
          // Khóa chia sẻ cho phép nhiều thí sinh bắt đầu cùng lúc nhưng chặn đổi lịch hoặc thêm đề chen ngang.
          const [[competition]] = await tx.query('SELECT * FROM competitions WHERE id = ? FOR SHARE', [competitionId]);
          if (!competition || competition.status !== 'published') throw examError(404, 'Không tìm thấy kỳ thi đã xuất bản.', 'NOT_FOUND');
          const start = date(competition.start_at);
          const end = date(competition.end_at);
          if (!start || !end || end <= start) throw examError(409, 'Kỳ thi chưa có lịch hợp lệ.', 'INVALID_SCHEDULE');
          if (now < start) throw examError(409, 'Kỳ thi chưa đến giờ bắt đầu.', 'COMPETITION_NOT_STARTED');
          if (now >= end) throw examError(409, 'Kỳ thi đã kết thúc.', 'COMPETITION_ENDED');
          const [[count]] = await tx.query(`SELECT COUNT(*) AS used FROM user_exam_sessions
            WHERE user_id = ? AND competition_id = ?`, [userId, competitionId]);
          const attempts = Number(count.used);
          if (attempts >= Number(competition.max_attempts)) throw examError(409, 'Bạn đã sử dụng hết số lượt thi của kỳ thi này.', 'ATTEMPT_LIMIT');
          // Chọn ngẫu nhiên từ mã đề trước, chỉ đọc nội dung đầy đủ của một đề được cấp.
          const [exams] = await tx.query(`SELECT id FROM exams
            WHERE competition_id = ? AND is_published = 1 AND question_snapshot IS NOT NULL ORDER BY id`, [competitionId]);
          if (!exams.length) throw examError(409, 'Kỳ thi chưa có đề được xuất bản.', 'NO_PUBLISHED_EXAM');
          const [[exam]] = await tx.query('SELECT id, name, code, question_snapshot FROM exams WHERE id = ?', [exams[randomIndex(exams.length)].id]);
          if (!exam) throw examError(409, 'Đề thi vừa thay đổi. Vui lòng thử bắt đầu lại.', 'EXAM_CHANGED');
          const questions = readSnapshot(exam.question_snapshot);
          now = await serverTime(tx);
          const expiresAt = computeDeadline(now, competition.duration_minutes, end);
          await registrationFor(tx, user, competitionId);
          const [created] = await tx.query(`INSERT INTO user_exam_sessions
            (user_id, exam_id, competition_id, question_ids, question_snapshot, answers, started_at, expires_at, status, revision, attempt_number, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', 0, ?, ?)`,
          [userId, exam.id, competitionId, JSON.stringify(questions.map(question => question.id)), JSON.stringify(questions), '{}', now, expiresAt, attempts + 1, now]);
          return sessionToPayload({ id: created.insertId, user_id: userId, exam_id: exam.id, competition_id: competitionId,
            question_snapshot: questions, answers: {}, revision: 0, started_at: now, expires_at: expiresAt,
            status: 'in_progress', score: null, attempt_number: attempts + 1 },
          { competitionName: competition.name, examName: exam.name, examCode: exam.code }, now);
        } catch (error) {
          // Vẫn ghi nhận bài vừa hết hạn khi yêu cầu lượt mới bị từ chối vì hết lượt hoặc hết lịch.
          if (finalized && error.status >= 400 && error.status < 500) return { deferredError: error };
          throw error;
        }
      });
      if (outcome.deferredError) throw outcome.deferredError;
      return outcome;
    },

    async session(userId, sessionId) {
      return pool.transaction(async tx => {
        await lockUser(tx, userId);
        let session = await lockSession(tx, sessionId, userId);
        const now = await serverTime(tx);
        if (isExpired(session, now)) session = await finishSession(tx, session, now, true);
        return payloadFor(tx, session, now);
      });
    },

    async save(userId, sessionId, { answers, revision }) {
      return pool.transaction(async tx => {
        await lockUser(tx, userId);
        let session = await lockSession(tx, sessionId, userId);
        const now = await serverTime(tx);
        if (isExpired(session, now)) session = await finishSession(tx, session, now, true);
        if (session.status !== 'in_progress') return payloadFor(tx, session, now);
        if (!validRevision(revision)) throw examError(400, 'Phiên bản bài làm không hợp lệ.', 'INVALID_REVISION');
        if (revision !== Number(session.revision)) {
          throw examError(409, 'Bài làm đã được cập nhật ở tab hoặc thiết bị khác. Vui lòng tải bản mới trước khi lưu.', 'REVISION_CONFLICT', await payloadFor(tx, session, now));
        }
        const selected = validateAnswers(answers, readSnapshot(session.question_snapshot));
        await tx.query('UPDATE user_exam_sessions SET answers = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [JSON.stringify(selected), now, session.id]);
        session = { ...session, answers: selected, revision: Number(session.revision) + 1 };
        return payloadFor(tx, session, now);
      });
    },

    async submit(userId, sessionId, body = {}) {
      return pool.transaction(async tx => {
        await lockUser(tx, userId);
        let session = await lockSession(tx, sessionId, userId);
        const now = await serverTime(tx);
        if (session.status !== 'in_progress') return payloadFor(tx, session, now);
        if (isExpired(session, now)) return payloadFor(tx, await finishSession(tx, session, now, true), now);
        if (Object.hasOwn(body, 'answers')) {
          if (!validRevision(body.revision)) throw examError(400, 'Phiên bản bài làm không hợp lệ.', 'INVALID_REVISION');
          if (body.revision !== Number(session.revision)) {
            throw examError(409, 'Bài làm đã được cập nhật. Vui lòng kiểm tra bản mới trước khi nộp.', 'REVISION_CONFLICT', await payloadFor(tx, session, now));
          }
          const answers = validateAnswers(body.answers, readSnapshot(session.question_snapshot));
          await tx.query('UPDATE user_exam_sessions SET answers = ?, updated_at = ? WHERE id = ?', [JSON.stringify(answers), now, session.id]);
          session = { ...session, answers };
        }
        return payloadFor(tx, await finishSession(tx, session, now), now);
      });
    },

    async results(userId, competitionId) {
      const params = [userId];
      if (competitionId !== undefined) params.push(competitionId);
      // Kết quả cũ chưa có liên kết phiên vẫn tra cứu được qua kỳ thi hoặc vòng thi của đề.
      const [rows] = await pool.query(`SELECT r.id, r.session_id AS sessionId, COALESCE(s.competition_id, rd.competition_id, e.competition_id) AS competitionId,
        c.name AS competitionName, e.name AS examName, s.attempt_number AS attemptNumber, r.score, r.finished_at AS finishedAt
        FROM results r JOIN exams e ON e.id = r.exam_id
        LEFT JOIN user_exam_sessions s ON s.id = r.session_id AND s.user_id = r.user_id AND s.exam_id = r.exam_id
        LEFT JOIN rounds rd ON rd.id = e.round_id
        LEFT JOIN competitions c ON c.id = COALESCE(s.competition_id, rd.competition_id, e.competition_id)
        WHERE r.user_id = ?${competitionId === undefined ? '' : ' AND COALESCE(s.competition_id, rd.competition_id, e.competition_id) = ?'}
        ORDER BY r.finished_at DESC, r.id DESC`, params);
      return rows.map(row => ({ ...row, attemptNumber: row.attemptNumber == null ? null : Number(row.attemptNumber), score: Number(row.score), finishedAt: iso(row.finishedAt) }));
    }
  };
}

// Worker xử lý cả khi thí sinh đóng trình duyệt; mỗi phiên chấm trong giao dịch riêng để không khóa cả danh sách.
export async function finalizeExpiredSessions(pool, { limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('INVALID_EXPIRATION_BATCH_SIZE');
  const [rows] = await pool.query(`SELECT id, user_id FROM user_exam_sessions
    WHERE status = 'in_progress' AND expires_at <= CURRENT_TIMESTAMP AND question_snapshot IS NOT NULL
    ORDER BY expires_at, id LIMIT ${limit}`);
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const changed = await pool.transaction(async tx => {
        // Giữ cùng thứ tự khóa với start/save/submit để tránh khóa chéo khi thêm kết quả có khóa ngoại user_id.
        await lockUser(tx, row.user_id);
        const session = await lockSession(tx, row.id);
        const now = await serverTime(tx);
        if (!isExpired(session, now)) return false;
        await finishSession(tx, session, now, true);
        return true;
      });
      if (changed) processed += 1;
    } catch (error) {
      failed += 1;
      console.error('Không thể chấm phiên hết hạn:', row.id, error.code || error.name);
    }
  }
  return { processed, failed };
}
