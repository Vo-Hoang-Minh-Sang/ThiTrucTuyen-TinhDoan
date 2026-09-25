import { randomInt } from 'node:crypto';
import { checkRoundEligibility, roundParticipation } from './rounds.js';

// Nghiệp vụ cốt lõi cho thí sinh: đăng ký, mở bài, lưu đáp án, nộp bài và tra cứu kết quả.
const choices = new Set(['A', 'B', 'C', 'D']);
const sessionColumns = `id, user_id, exam_id, competition_id, round_id, question_snapshot, answers,
  revision, started_at, expires_at, status, score, finished_at, attempt_number`;

export function examError(status, message, code, item) {
  // Chuẩn hóa lỗi nghiệp vụ để router trả đúng HTTP status và mã lỗi cho frontend.
  return Object.assign(new Error(message), { status, code, ...(item ? { item } : {}) });
}

function parseJson(value) {
  // Dữ liệu JSON từ MySQL có thể đã là object hoặc vẫn ở dạng chuỗi tùy driver/câu truy vấn.
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
    question.points = Number(question.points ?? 1);
    const key = String(question?.id);
    if (!/^\d+$/.test(key) || ids.has(key) || !choices.has(question.correctAnswer)
      || !Number.isFinite(Number(question.points)) || Number(question.points) <= 0
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
  // ?i?m b?i thi l? t?ng ?i?m c?a c?c c?u tr? l?i ??ng, kh?ng quy ??i v? thang 100.
  const score = questions.reduce((total, question) => total + (answers[String(question.id)] === question.correctAnswer ? Number(question.points ?? 1) : 0), 0);
  return Math.round(score * 100) / 100;
}

export function computeDeadline(startedAt, durationMinutes, closesAt) {
  return computeDeadlineSeconds(startedAt, Number(durationMinutes) * 60, closesAt);
}

export function computeDeadlineSeconds(startedAt, durationSeconds, closesAt) {
  // Hạn bài là mốc sớm hơn giữa thời lượng được cấp và thời điểm vòng/kỳ thi kết thúc.
  const start = date(startedAt);
  const end = date(closesAt);
  const duration = Number(durationSeconds);
  if (!start || !end || !Number.isInteger(duration) || duration < 1 || end <= start) {
    throw examError(409, 'Kỳ thi chưa có lịch hoặc thời lượng hợp lệ.', 'INVALID_SCHEDULE');
  }
  return new Date(Math.min(start.getTime() + duration * 1_000, end.getTime()));
}

export function sessionToPayload(session, details, now) {
  // Đây là payload duy nhất gửi cho trình duyệt; đáp án đúng luôn bị loại khỏi danh sách câu hỏi.
  const questions = readSnapshot(session.question_snapshot);
  return {
    id: session.id, competitionId: session.competition_id, competitionName: details.competitionName, roundId: session.round_id ?? null, roundName: details.roundName || null,
    examId: session.exam_id, examName: details.examName, examCode: details.examCode,
    // Liệt kê rõ trường công khai, tuyệt đối không đưa khóa đáp án hoặc dữ liệu phân loại ra trình duyệt.
    questions: questions.map(({ id, content, optionA, optionB, optionC, optionD }) => ({ id, content, optionA, optionB, optionC, optionD })),
    answers: validateAnswers(parseJson(session.answers) ?? {}, questions),
    revision: Number(session.revision), startedAt: iso(session.started_at), expiresAt: iso(details.competitionStatus === 'paused' && details.pausedAt ? new Date(date(session.expires_at).getTime() + Math.max(0, now.getTime() - date(details.pausedAt).getTime())) : session.expires_at),
    finishedAt: iso(session.finished_at), durationSeconds: session.finished_at ? Math.max(0, Math.floor((date(session.finished_at) - date(session.started_at)) / 1000)) : null,
    serverNow: iso(now), status: session.status, paused: details.competitionStatus === 'paused', score: session.score === null || session.score === undefined ? null : Number(session.score),
    attemptNumber: Number(session.attempt_number)
  };
}

async function serverTime(tx) {
  // Dùng đồng hồ database để tránh việc thời gian máy người dùng ảnh hưởng đến hạn nộp bài.
  const [[row]] = await tx.query('SELECT CURRENT_TIMESTAMP AS server_now');
  const now = date(row?.server_now);
  if (!now) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
  return now;
}

async function detailsFor(tx, session) {
  // Bổ sung tên kỳ thi, vòng và đề cho payload mà không tin dữ liệu từ client.
  const [[details]] = await tx.query(`SELECT c.name AS competitionName, c.status AS competitionStatus, c.paused_at AS pausedAt, e.name AS examName, e.code AS examCode, rd.name AS roundName
    FROM exams e JOIN competitions c ON c.id = ? LEFT JOIN rounds rd ON rd.id=e.round_id WHERE e.id = ?`, [session.competition_id, session.exam_id]);
  if (!details) throw examError(404, 'Không tìm thấy kỳ thi hoặc đề thi của bài làm.', 'NOT_FOUND');
  return details;
}

async function payloadFor(tx, session, now) {
  return sessionToPayload(session, await detailsFor(tx, session), now);
}

async function competitionPaused(tx, competitionId) {
  // Kiểm tra trong chính giao dịch để không ghi đáp án hoặc chấm bài sau thời điểm tạm đóng.
  const [[competition]] = await tx.query('SELECT status FROM competitions WHERE id=? LOCK IN SHARE MODE', [competitionId]);
  return competition?.status === 'paused';
}

async function lockUser(tx, userId) {
  // Khóa tài khoản trước các thao tác thay đổi phiên để tuần tự hóa yêu cầu đồng thời cùng người dùng.
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
  // Khóa bản ghi phiên và đồng thời kiểm tra quyền sở hữu nếu có userId.
  const [rows] = await tx.query(`SELECT ${sessionColumns} FROM user_exam_sessions
    WHERE id = ?${userId === undefined ? '' : ' AND user_id = ?'} FOR UPDATE`, userId === undefined ? [sessionId] : [sessionId, userId]);
  if (!rows[0]) throw examError(404, 'Không tìm thấy bài làm.', 'NOT_FOUND');
  return rows[0];
}

function isExpired(session, now) {
  return session.status === 'in_progress' && date(session.expires_at) && date(session.expires_at) <= now;
}

async function finishSession(tx, session, now, expired = false) {
  // Chấm từ ảnh chụp đề và đáp án đã lưu; không đọc lại ngân hàng câu hỏi có thể đã thay đổi.
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
  await tx.query(`INSERT INTO results (user_id, exam_id, session_id, score, finished_at, started_at, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [session.user_id, session.exam_id, session.id, score, finishedAt, session.started_at, Math.max(0, Math.floor((finishedAt - date(session.started_at)) / 1000))]);
  return { ...session, score, finished_at: finishedAt, status, revision };
}

function validRevision(value) { return Number.isSafeInteger(value) && value >= 0; }

function competitionPayload(row, now) {
  // Chỉ tính trạng thái hiển thị từ lịch và trạng thái công bố do backend quản lý.
  const start = date(row.start_at);
  const end = date(row.end_at);
  const scheduled = start && end && end > start;
  const used = Number(row.attemptsUsed ?? 0);
  return {
    id: row.id, name: row.name, description: row.description,
    startAt: iso(start), endAt: iso(end), durationMinutes: Number(row.duration_minutes), maxAttempts: Number(row.max_attempts),
    attemptsUsed: used, attemptsRemaining: Math.max(0, Number(row.max_attempts) - used),
    registered: Number(row.registered) > 0, activeSessionId: row.activeSessionId ?? null,
    status: row.status === 'paused' ? 'paused' : row.status === 'closed' ? 'closed' : !scheduled ? 'unscheduled' : now < start ? 'upcoming' : now >= end ? 'ended' : 'active'
  };
}

// Mọi quyết định về hạn thi lấy giờ của database, không tin đồng hồ hoặc điểm số từ trình duyệt.
export function createCandidateService({ pool, randomIndex = randomInt }) {
  return {
    async competitions(userId, { from, to } = {}) {
      // Trả danh sách kỳ thi cùng trạng thái từng vòng cho riêng thí sinh hiện tại.
      const now = await serverTime(pool);
      // Ky thi tam dong khong xuat hien trong danh sach cua thi sinh.
      const filters = ["c.status IN ('published','closed')"];
      const params = [userId, userId, userId, now];
      if (from) { filters.push('c.end_at >= ?'); params.push(from); }
      if (to) { filters.push('c.start_at < ?'); params.push(to); }
      const [rows] = await pool.query(`SELECT c.*,
        (SELECT COUNT(*) FROM user_exam_sessions s WHERE s.user_id = ? AND s.competition_id = c.id) AS attemptsUsed,
        (SELECT COUNT(*) FROM competition_registrations cr WHERE cr.user_id = ? AND cr.competition_id = c.id) AS registered,
        (SELECT s.id FROM user_exam_sessions s WHERE s.user_id = ? AND s.competition_id = c.id
          AND s.status = 'in_progress' AND s.expires_at > ? ORDER BY s.id DESC LIMIT 1) AS activeSessionId
        FROM competitions c WHERE ${filters.join(' AND ')} ORDER BY c.start_at DESC, c.id DESC`, params);
      return Promise.all(rows.map(async row => {
        const item = competitionPayload(row, now);
        const [rounds] = await pool.query('SELECT * FROM rounds WHERE competition_id=? AND enabled=1 ORDER BY round_number,id', [row.id]);
        item.rounds = await Promise.all(rounds.map(async round => {
          const [[counts]] = await pool.query(`SELECT COUNT(*) AS used,SUM(finished_at IS NOT NULL) AS completed,MAX(CASE WHEN status='in_progress' AND expires_at>? THEN id ELSE NULL END) AS activeSessionId FROM user_exam_sessions WHERE user_id=? AND competition_id=? AND round_id=?`, [now,userId,row.id,round.id]);
          const [[exam]] = await pool.query('SELECT id FROM exams WHERE competition_id=? AND round_id=? AND is_published=1 AND question_snapshot IS NOT NULL LIMIT 1', [row.id,round.id]);
          let eligible = true, eligibilityMessage = '';
          try { await checkRoundEligibility(pool,userId,round); } catch (error) { if (!error.status) throw error; eligible=false; eligibilityMessage=error.message; }
          const participation = roundParticipation({ round, competition: row, now, registered: item.registered, eligible, eligibilityMessage, used: Number(counts.used), completed: Number(counts.completed), activeSessionId: counts.activeSessionId, hasExam: Boolean(exam) });
          return { id: round.id, name: round.name || `Vòng ${round.round_number}`, roundNumber: Number(round.round_number), startAt: iso(round.start_datetime), endAt: iso(round.end_datetime), durationMinutes: Number(round.duration_minutes), durationSeconds: Number(round.duration_seconds ?? Number(round.duration_minutes) * 60), finalized: Boolean(round.finalized_at), eligible, attemptsUsed: Number(counts.used), attemptsRemaining: Math.max(0,Number(row.max_attempts)-Number(counts.used)), activeSessionId: counts.activeSessionId, ...participation };
        }));
        item.currentRoundId = item.rounds.find(r=>r.scheduleStatus==='active'&&!r.finalized)?.id || item.rounds.find(r=>r.scheduleStatus==='upcoming'&&!r.finalized)?.id || item.rounds.at(-1)?.id || null;
        return item;
      }));
    },

    async register(userId, competitionId) {
      // Đăng ký là bước riêng, không tự phát sinh khi thí sinh bấm bắt đầu làm bài.
      return pool.transaction(async tx => {
        const user = await lockUser(tx, userId);
        const [[competition]] = await tx.query('SELECT * FROM competitions WHERE id = ? LOCK IN SHARE MODE', [competitionId]);
        const now = await serverTime(tx);
        if (competition?.status === 'paused') throw examError(423, 'Cuộc thi đang bị tạm dừng.', 'COMPETITION_PAUSED');
        if (!competition || competition.status !== 'published') throw examError(404, 'Không tìm thấy kỳ thi đã xuất bản.', 'NOT_FOUND');
        if (date(competition.end_at) && now >= date(competition.end_at)) throw examError(409, 'Kỳ thi đã kết thúc đăng ký.', 'REGISTRATION_CLOSED');
        // Đăng ký chỉ mở đến khi vòng đầu tiên kết thúc; không dùng vòng đang chọn trên giao diện.
        const [[firstRound]] = await tx.query(`SELECT end_datetime FROM rounds
          WHERE competition_id=? AND enabled=1 ORDER BY round_number,id LIMIT 1 LOCK IN SHARE MODE`, [competitionId]);
        if (firstRound?.end_datetime && now >= date(firstRound.end_datetime)) {
          throw examError(409, 'Đã hết thời gian đăng ký vì vòng thi thứ nhất đã kết thúc.', 'REGISTRATION_CLOSED');
        }
        return registrationFor(tx, user, competitionId);
      });
    },

    async start(userId, competitionId, requestedRoundId) {
      // Tạo hoặc khôi phục phiên thi trong giao dịch để tránh vượt số lượt khi mở nhiều tab.
      const outcome = await pool.transaction(async tx => {
        await lockUser(tx, userId);
        // Đăng ký cuộc thi là bước riêng; bắt đầu bài không được tự tạo đăng ký hoặc tiêu hao lượt khi chưa đăng ký.
        const [[registration]] = await tx.query(`SELECT registered_at FROM competition_registrations
          WHERE user_id = ? AND competition_id = ?`, [userId, competitionId]);
        if (!registration) throw examError(403, 'Bạn cần đăng ký cuộc thi này trước khi làm bài.', 'REGISTRATION_REQUIRED');
        const [[initialCompetition]] = await tx.query('SELECT * FROM competitions WHERE id = ? LOCK IN SHARE MODE', [competitionId]);
        if (initialCompetition?.status === 'paused') throw examError(423, 'Cuộc thi đang bị tạm dừng.', 'COMPETITION_PAUSED');
        const [rounds] = await tx.query('SELECT * FROM rounds WHERE competition_id=? AND enabled=1 ORDER BY round_number,id', [competitionId]);
        const clock = await serverTime(tx);
        const round = requestedRoundId ? rounds.find(r => String(r.id) === String(requestedRoundId)) : rounds.find(r => date(r.start_datetime) <= clock && clock < date(r.end_datetime) && !r.finalized_at);
        if ((rounds.length || requestedRoundId) && !round) throw examError(409, 'Không có vòng thi phù hợp đang mở.', 'ROUND_UNAVAILABLE');
        if (round) await checkRoundEligibility(tx, userId, round);
        const roundId = round?.id ?? null;
        // Khóa tài khoản tuần tự hóa cả việc kiểm tra số lượt và tạo phiên, kể cả mở nhiều tab cùng lúc.
        const [active] = await tx.query(`SELECT ${sessionColumns} FROM user_exam_sessions
          WHERE user_id = ? AND competition_id = ? AND status = 'in_progress' AND (? IS NULL OR round_id = ?) ORDER BY id DESC FOR UPDATE`, [userId, competitionId, roundId, roundId]);
        let now = await serverTime(tx);
        let finalized = false;
        for (const session of active) {
          if (isExpired(session, now)) { await finishSession(tx, session, now, true); finalized = true; }
          else return payloadFor(tx, session, now);
        }
        try {
          // Khóa chia sẻ cho phép nhiều thí sinh bắt đầu cùng lúc nhưng chặn đổi lịch hoặc thêm đề chen ngang.
          const [[competition]] = await tx.query('SELECT * FROM competitions WHERE id = ? LOCK IN SHARE MODE', [competitionId]);
          if (!competition || competition.status !== 'published') throw examError(404, 'Không tìm thấy kỳ thi đã xuất bản.', 'NOT_FOUND');
          const start = round ? new Date(Math.max(date(round.start_datetime)?.getTime() || 0, date(competition.start_at)?.getTime() || 0)) : date(competition.start_at);
          const end = round ? new Date(Math.min(date(round.end_datetime)?.getTime() || 0, date(competition.end_at)?.getTime() || 0)) : date(competition.end_at);
          if (!start || !end || end <= start) throw examError(409, 'Kỳ thi chưa có lịch hợp lệ.', 'INVALID_SCHEDULE');
          if (now < start) throw examError(409, 'Kỳ thi chưa đến giờ bắt đầu.', 'COMPETITION_NOT_STARTED');
          if (now >= end) throw examError(409, 'Kỳ thi đã kết thúc.', 'COMPETITION_ENDED');
          // Mỗi vòng có số lượt độc lập. Kỳ thi cũ không cấu hình vòng vẫn giữ cách đếm theo toàn kỳ thi.
          const attemptWhere = roundId === null ? 'user_id = ? AND competition_id = ?' : 'user_id = ? AND competition_id = ? AND round_id = ?';
          const attemptValues = roundId === null ? [userId, competitionId] : [userId, competitionId, roundId];
          const [[count]] = await tx.query(`SELECT COUNT(*) AS used FROM user_exam_sessions WHERE ${attemptWhere}`, attemptValues);
          const attempts = Number(count.used);
          if (attempts >= Number(competition.max_attempts)) throw examError(409, roundId === null ? 'Bạn đã sử dụng hết số lượt thi của kỳ thi này.' : 'Bạn đã sử dụng hết số lượt thi của vòng này.', 'ATTEMPT_LIMIT');
          // Chọn ngẫu nhiên từ mã đề trước, chỉ đọc nội dung đầy đủ của một đề được cấp.
          const [exams] = await tx.query(`SELECT id FROM exams
            WHERE competition_id = ? AND (? IS NULL OR round_id = ?) AND is_published = 1 AND question_snapshot IS NOT NULL ORDER BY id`, [competitionId, roundId, roundId]);
          if (!exams.length) throw examError(409, 'Kỳ thi chưa có đề được xuất bản.', 'NO_PUBLISHED_EXAM');
          const [[exam]] = await tx.query('SELECT id, name, code, question_snapshot FROM exams WHERE id = ?', [exams[randomIndex(exams.length)].id]);
          if (!exam) throw examError(409, 'Đề thi vừa thay đổi. Vui lòng thử bắt đầu lại.', 'EXAM_CHANGED');
          const questions = readSnapshot(exam.question_snapshot);
          now = await serverTime(tx);
          const expiresAt = round ? computeDeadlineSeconds(now, Number(round.duration_seconds ?? Number(round.duration_minutes) * 60), end) : computeDeadline(now, competition.duration_minutes, end);
          const [created] = await tx.query(`INSERT INTO user_exam_sessions
            (user_id, exam_id, competition_id, question_ids, question_snapshot, answers, started_at, expires_at, status, revision, attempt_number, updated_at, round_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', 0, ?, ?, ?)`,
          [userId, exam.id, competitionId, JSON.stringify(questions.map(question => question.id)), JSON.stringify(questions), '{}', now, expiresAt, attempts + 1, now, roundId]);
          return sessionToPayload({ id: created.insertId, user_id: userId, exam_id: exam.id, competition_id: competitionId, round_id: roundId,
            question_snapshot: questions, answers: {}, revision: 0, started_at: now, expires_at: expiresAt,
            status: 'in_progress', score: null, attempt_number: attempts + 1 },
          { competitionName: competition.name, examName: exam.name, examCode: exam.code, roundName: round?.name || null }, now);
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
      // Khi tải lại bài, kiểm tra hạn trước khi trả dữ liệu để có thể tự nộp đúng lúc.
      return pool.transaction(async tx => {
        await lockUser(tx, userId);
        let session = await lockSession(tx, sessionId, userId);
        const now = await serverTime(tx);
        if (await competitionPaused(tx, session.competition_id)) return payloadFor(tx, session, now);
        if (isExpired(session, now)) session = await finishSession(tx, session, now, true);
        return payloadFor(tx, session, now);
      });
    },

    async sessionStatus(userId, sessionId) {
      // Endpoint nhẹ cho trình duyệt kiểm tra tạm đóng, không khóa phiên hay đọc nội dung bài thi.
      const [[item]] = await pool.query(`SELECT s.status AS sessionStatus, s.expires_at AS expiresAt, c.status AS competitionStatus, c.paused_at AS pausedAt,
        CURRENT_TIMESTAMP AS serverNow FROM user_exam_sessions s JOIN competitions c ON c.id=s.competition_id
        WHERE s.id=? AND s.user_id=?`, [sessionId, userId]);
      if (!item) throw examError(404, 'Không tìm thấy bài làm.', 'NOT_FOUND');
      // Gửi lại hạn nộp vì nó có thể được gia hạn sau khi cuộc thi mở lại.
      const now = date(item.serverNow);
      const expiresAt = item.competitionStatus === 'paused' && item.pausedAt ? new Date(date(item.expiresAt).getTime() + Math.max(0, now.getTime() - date(item.pausedAt).getTime())) : item.expiresAt;
      return { status: item.sessionStatus, expiresAt: iso(expiresAt), paused: item.competitionStatus === 'paused', serverNow: iso(item.serverNow) };
    },

    async save(userId, sessionId, { answers, revision }) {
      // revision chống ghi đè đáp án khi người dùng mở nhiều tab hoặc thiết bị.
      return pool.transaction(async tx => {
        await lockUser(tx, userId);
        let session = await lockSession(tx, sessionId, userId);
        const now = await serverTime(tx);
        if (await competitionPaused(tx, session.competition_id)) throw examError(423, 'Cuộc thi đang bị tạm dừng.', 'COMPETITION_PAUSED');
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
      // Nộp bài lặp lại an toàn: phiên đã kết thúc chỉ trả lại kết quả đã chấm.
      return pool.transaction(async tx => {
        await lockUser(tx, userId);
        let session = await lockSession(tx, sessionId, userId);
        const now = await serverTime(tx);
        if (await competitionPaused(tx, session.competition_id)) throw examError(423, 'Cuộc thi đang bị tạm dừng.', 'COMPETITION_PAUSED');
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
      // Chỉ lấy kết quả của chính thí sinh; có thể lọc thêm theo một kỳ thi.
      const params = [userId];
      if (competitionId !== undefined) params.push(competitionId);
      // Kết quả cũ chưa có liên kết phiên vẫn tra cứu được qua kỳ thi hoặc vòng thi của đề.
      const [rows] = await pool.query(`SELECT r.id, r.session_id AS sessionId, COALESCE(s.competition_id, rd.competition_id, e.competition_id) AS competitionId,
        c.name AS competitionName, e.name AS examName, s.attempt_number AS attemptNumber, r.score, r.finished_at AS finishedAt, r.started_at AS startedAt, r.duration_seconds AS durationSeconds, r.round_rank AS roundRank, r.advanced, rd.id AS roundId, rd.name AS roundName
        FROM results r JOIN exams e ON e.id = r.exam_id
        LEFT JOIN user_exam_sessions s ON s.id = r.session_id AND s.user_id = r.user_id AND s.exam_id = r.exam_id
        LEFT JOIN rounds rd ON rd.id = COALESCE(s.round_id,e.round_id)
        LEFT JOIN competitions c ON c.id = COALESCE(s.competition_id, rd.competition_id, e.competition_id)
        WHERE r.user_id = ?${competitionId === undefined ? '' : ' AND COALESCE(s.competition_id, rd.competition_id, e.competition_id) = ?'}
        ORDER BY r.finished_at DESC, r.id DESC`, params);
      return rows.map(row => ({ ...row, attemptNumber: row.attemptNumber == null ? null : Number(row.attemptNumber), score: Number(row.score), startedAt: iso(row.startedAt), durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds), roundRank: row.roundRank == null ? null : Number(row.roundRank), advanced: row.advanced == null ? null : Boolean(Number(row.advanced)), finishedAt: iso(row.finishedAt) }));
    }
  };
}

// Worker xử lý cả khi thí sinh đóng trình duyệt; mỗi phiên chấm trong giao dịch riêng để không khóa cả danh sách.
export async function finalizeExpiredSessions(pool, { limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('INVALID_EXPIRATION_BATCH_SIZE');
  const [rows] = await pool.query(`SELECT s.id, s.user_id FROM user_exam_sessions s
    JOIN competitions c ON c.id=s.competition_id
    WHERE s.status = 'in_progress' AND s.expires_at <= CURRENT_TIMESTAMP AND s.question_snapshot IS NOT NULL AND c.status<>'paused'
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
        if (await competitionPaused(tx, session.competition_id)) return false;
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
