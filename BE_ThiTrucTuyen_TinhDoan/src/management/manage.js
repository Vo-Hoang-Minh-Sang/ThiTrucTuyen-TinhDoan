import { Router } from 'express';
import { randomInt, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createAccess, requireRoles, assertCompetitionAccess } from '../auth/access.js';
import { audit, fail, integer, iso, positiveId, requirePermission, route, textField } from '../common/http.js';
import { QUESTION_HEADERS, readQuestionWorkbook, sendWorkbook, styledSheet, upload } from '../site/files.js';
import { createUserManagementRouter } from './manage-users.js';
import { rankResults, roundScope } from '../exam/rounds.js';

// Tập hợp API quản trị: kỳ thi, vòng thi, ngân hàng câu hỏi, đề thi và thí sinh.
const questionColumns = 'q.id, q.competition_id AS competitionId, q.round_id AS roundId, q.content, q.optionA, q.optionB, q.optionC, q.optionD, q.correctAnswer, q.difficulty, q.points';
// Tệp Excel dùng nhãn tiếng Việt, còn cơ sở dữ liệu giữ mã ngắn để tương thích dữ liệu hiện có.
const difficultyValues = { easy: 'easy', medium: 'medium', hard: 'hard', 'dễ': 'easy', 'trung bình': 'medium', 'khó': 'hard' };
// Chuyển dữ liệu CSDL từ dạng snake_case thành dữ liệu API nhất quán cho frontend.
export const competitionPayload = row => ({ id: row.id, name: row.name, description: row.description || '', durationMinutes: Number(row.duration_minutes), maxAttempts: Number(row.max_attempts), hasExams: Boolean(Number(row.has_exams)), startAt: iso(row.start_at), endAt: iso(row.end_at), status: row.status });
// Trả đủ dữ liệu để frontend nhận diện vòng đang bật và hiển thị đúng cấu hình Top N.
export const roundPayload = row => ({ id: row.id, competitionId: Number(row.competition_id), name: row.name || `Vòng ${row.round_number}`, roundNumber: Number(row.round_number), durationMinutes: Number(row.duration_minutes), durationSeconds: Number(row.duration_seconds ?? Number(row.duration_minutes) * 60), advanceCount: Number(row.advance_count), enabled: Boolean(Number(row.enabled)), finalized: Boolean(row.finalized_at), finalizedAt: iso(row.finalized_at), startAt: iso(row.start_datetime), endAt: iso(row.end_datetime) });

export function validateQuestion(body) {
  // Kiểm tra dữ liệu dùng chung cho nhập tay và nhập từ tệp Excel.
  const item = { competitionId: positiveId(body.competitionId, 'Kỳ thi'), roundId: positiveId(body.roundId, 'Vòng thi') };
  for (const key of ['content', 'optionA', 'optionB', 'optionC', 'optionD']) item[key] = textField(body[key], key === 'content' ? 'Nội dung câu hỏi' : `Đáp án ${key.at(-1)}`, key === 'content' ? 10000 : 4000);
  if (!['A', 'B', 'C', 'D'].includes(body.correctAnswer)) throw fail(400, 'Đáp án đúng phải là A, B, C hoặc D.');
  item.correctAnswer = body.correctAnswer;
  const difficultyLabel = String(body.difficulty || 'medium').trim().toLocaleLowerCase('vi');
  item.difficulty = difficultyValues[difficultyLabel];
  if (!item.difficulty) throw fail(400, 'Độ khó phải là Dễ, Trung bình hoặc Khó.');
  // Kh?ng nh?p s? ?i?m th? d?ng m?t ?i?m; ?p d?ng th?ng nh?t cho bi?u m?u v? t?ng d?ng Excel.
  item.points = body.points === undefined || body.points === null || String(body.points).trim() === '' ? 1 : Number(body.points);
  if (!Number.isFinite(item.points) || item.points <= 0 || item.points > 1000000 || Math.round(item.points * 100) !== item.points * 100) throw fail(400, 'Số điểm phải lớn hơn 0 và có tối đa 2 chữ số thập phân.');
  return item;
}
const questionValues = item => [item.competitionId, item.roundId, item.content, item.optionA, item.optionB, item.optionC, item.optionD, item.correctAnswer, item.difficulty, item.points];
const snapshot = q => Object.fromEntries(['id', 'content', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'difficulty', 'points'].map(key => [key, q[key]]));
async function insertQuestion(db, item, actor) {
  const [result] = await db.query('INSERT INTO questions (competition_id, round_id, content, optionA, optionB, optionC, optionD, correctAnswer, difficulty, points, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...questionValues(item), actor]);
  return result.insertId;
}
async function assertQuestionRound(db, item) {
  // Mỗi câu hỏi phải thuộc đúng một vòng đang bật, không dùng chung cho toàn bộ kỳ thi.
  const round = await roundScope(db, item.competitionId, item.roundId);
  if (!round) throw fail(400, 'Hãy tạo vòng thi trước khi thêm câu hỏi.');
  return round;
}
async function assertCompetitionDraft(db, competitionId) {
  // Không cho chỉnh sửa dữ liệu cấu hình sau khi kỳ thi đã được thông báo.
  const [[competition]] = await db.query('SELECT id,status FROM competitions WHERE id=?', [competitionId]);
  if (!competition) throw fail(404, 'Kỳ thi không tồn tại.');
  if (!['draft', 'paused'].includes(competition.status)) throw fail(409, 'Chỉ có thể chỉnh sửa vòng, câu hỏi và đề thi khi kỳ thi ở trạng thái Bản nháp hoặc Tạm đóng.');
  return competition;
}
export function competitionInput(body) {
  // Không cho phép tạo lịch thi có thời điểm kết thúc trước thời điểm bắt đầu.
  const startAt = new Date(body.startAt), endAt = new Date(body.endAt);
  if (typeof body.startAt !== 'string' || typeof body.endAt !== 'string' || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) throw fail(400, 'Cần thời gian bắt đầu và kết thúc hợp lệ; kết thúc phải sau bắt đầu.');
  // Thời lượng chính thức thuộc từng vòng; giữ giá trị mặc định chỉ để tương thích kỳ thi cũ chưa có vòng.
  const durationMinutes = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === '' ? 30 : integer(body.durationMinutes, 'Thời lượng', 1, 600);
  const status = body.status || 'draft';
  if (!['draft', 'published', 'paused', 'closed'].includes(status)) throw fail(400, 'Trạng thái kỳ thi không hợp lệ.');
  // Điểm chuẩn áp dụng cho tất cả vòng của kỳ thi; 0 nghĩa là không loại theo điểm.
  return { name: textField(body.name, 'Tên kỳ thi'), description: textField(body.description, 'Mô tả', 10000, true), durationMinutes, maxAttempts: integer(body.maxAttempts, 'Số lượt thi', 1, 100), startAt, endAt, status };
}

// Chi mot ky thi duoc thong bao trong cung mot khoang thoi gian de thi sinh khong phai chon giua cac ky thi.
async function assertNoPublishedScheduleOverlap(db, item, excludedId = null) {
  if (item.status !== 'published') return;
  const values = [item.endAt, item.startAt];
  const excluded = excludedId ? ' AND id<>?' : '';
  if (excludedId) values.push(excludedId);
  const [[overlap]] = await db.query(`SELECT id,name FROM competitions
    WHERE status='published' AND start_at<? AND end_at>?${excluded}
    ORDER BY start_at,id LIMIT 1 FOR UPDATE`, values);
  if (overlap) throw fail(409, `Th\u1eddi gian k\u1ef3 thi tr\u00f9ng v\u1edbi k\u1ef3 thi \u0111ang th\u00f4ng b\u00e1o: ${overlap.name}.`);
}

// Kỳ thi vừa được thông báo sẽ là nội dung ưu tiên trên trang chủ.
async function pinPublishedCompetition(db, competitionId, status) {
  if (status !== 'published') return;
  await db.query(`INSERT INTO site_settings (id,title,pinned_competition_id)
    VALUES (1,?,?) ON DUPLICATE KEY UPDATE pinned_competition_id=VALUES(pinned_competition_id),updated_at=CURRENT_TIMESTAMP`, ['Thi trực tuyến Tỉnh Đoàn', competitionId]);
}

export function roundInput(body, competition) {
  // Mỗi vòng phải nằm hoàn toàn trong khoảng thời gian của kỳ thi cha.
  const startAt = new Date(body.startAt), endAt = new Date(body.endAt);
  if (typeof body.startAt !== 'string' || typeof body.endAt !== 'string' || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) throw fail(400, 'Cần thời gian bắt đầu và kết thúc vòng hợp lệ; kết thúc phải sau bắt đầu.');
  const competitionStart = new Date(competition.start_at), competitionEnd = new Date(competition.end_at);
  if (startAt < competitionStart || endAt > competitionEnd) throw fail(400, 'Thời gian vòng thi phải nằm trong thời gian của kỳ thi.');
  const durationSeconds = body.durationSeconds === undefined || body.durationSeconds === null || body.durationSeconds === ''
    ? integer(body.durationMinutes || competition.duration_minutes, 'Thời lượng vòng', 1, 600) * 60
    : integer(body.durationSeconds, 'Thời lượng vòng', 1, 36_000);
  const durationMinutes = Math.ceil(durationSeconds / 60);
  if (endAt.getTime() - startAt.getTime() <= durationSeconds * 1_000) throw fail(400, 'Thời gian diễn ra vòng thi phải lớn hơn thời lượng làm bài.');
  return {
    name: textField(body.name || `Vòng ${body.roundNumber}`, 'Tên vòng thi', 255),
    roundNumber: integer(body.roundNumber, 'Số vòng', 1, 1000),
    durationMinutes,
    durationSeconds,
    advanceCount: integer(body.advanceCount ?? 0, 'Số thí sinh qua vòng', 0, 1000000),
    startAt,
    endAt
  };
}
// Gi? c?c v?ng theo th? t? th?i gian ?? v?ng sau ch? m? khi v?ng tr??c ?? k?t th?c.
async function assertRoundSequence(db, competitionId, item, excludedRoundId = null) {
  const values = [competitionId, item.roundNumber]; let excluded = '';
  if (excludedRoundId) { excluded = ' AND id<>?'; values.push(excludedRoundId); }
  const [[previous]] = await db.query(`SELECT end_datetime FROM rounds WHERE competition_id=? AND round_number<?${excluded} ORDER BY round_number DESC LIMIT 1`, values);
  if (previous && item.startAt <= new Date(previous.end_datetime)) throw fail(400, 'V\u00f2ng sau ph\u1ea3i b\u1eaft \u0111\u1ea7u sau khi v\u00f2ng tr\u01b0\u1edbc k\u1ebft th\u00fac.');
  const nextValues = [competitionId, item.roundNumber]; let nextExcluded = '';
  if (excludedRoundId) { nextExcluded = ' AND id<>?'; nextValues.push(excludedRoundId); }
  const [[next]] = await db.query(`SELECT start_datetime FROM rounds WHERE competition_id=? AND round_number>?${nextExcluded} ORDER BY round_number ASC LIMIT 1`, nextValues);
  if (next && item.endAt >= new Date(next.start_datetime)) throw fail(400, 'V\u00f2ng n\u00e0y ph\u1ea3i k\u1ebft th\u00fac tr\u01b0\u1edbc khi v\u00f2ng ti\u1ebfp theo b\u1eaft \u0111\u1ea7u.');
}

function scopedWhere(user, alias, permission, values) {
  // Giảng viên chỉ được thao tác với các kỳ thi đã được phân công.
  requirePermission(user, permission);
  if (user.role === 'admin') return '1=1';
  values.push(user.id);
  return `EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id = ${alias} AND tc.user_id = ?)`;
}

export function createManageRouter({ pool }) {
  // Mọi API trong router này yêu cầu giảng viên hoặc quản trị viên đăng nhập.
  const router = Router();
  router.use(createAccess({ pool }), requireRoles('teacher', 'admin'));
  router.get('/competitions', route(async (req, res) => {
    const values = [];
    const where = req.user.role === 'admin' ? '1=1' : (values.push(req.user.id), 'EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id = c.id AND tc.user_id = ?)');
    const [rows] = await pool.query(`SELECT c.*,EXISTS(SELECT 1 FROM exams e WHERE e.competition_id=c.id) AS has_exams FROM competitions c WHERE ${where} ORDER BY c.id DESC`, values);
    res.json({ success: true, items: rows.map(competitionPayload) });
  }));
  router.post('/competitions', requireRoles('admin'), route(async (req, res) => {
    const item = competitionInput(req.body);
    const id = await pool.transaction(async tx => {
      await assertNoPublishedScheduleOverlap(tx, item);
      const [result] = await tx.query('INSERT INTO competitions (name, description, start_date, end_date, duration_minutes, max_attempts, start_at, end_at, status, created_by) VALUES (?, ?, DATE(?), DATE(?), ?, ?, ?, ?, ?, ?)', [item.name, item.description, item.startAt, item.endAt, item.durationMinutes, item.maxAttempts, item.startAt, item.endAt, item.status, req.user.id]);
      await pinPublishedCompetition(tx, result.insertId, item.status);
      await audit(tx, req.user.id, 'competition.create', 'competition', result.insertId);
      if (item.status === 'published') await audit(tx, req.user.id, 'competition.open', 'competition', result.insertId, { competitionName: item.name, previousStatus: null, nextStatus: item.status });
      return result.insertId;
    });
    res.status(201).json({ success: true, item: { id, ...item } });
  }));
  router.put('/competitions/:id', requireRoles('admin'), route(async (req, res) => {
    const id = positiveId(req.params.id), item = competitionInput(req.body);
    await pool.transaction(async tx => {
      const [[current]] = await tx.query('SELECT * FROM competitions WHERE id = ? FOR UPDATE', [id]);
      if (!current) throw fail(404, 'Kỳ thi không tồn tại.');
      await assertNoPublishedScheduleOverlap(tx, item, id);
      // Kỳ thi đã đóng hoặc đã hết lịch là dữ liệu lịch sử, không cho mở lại để cấu hình.
      if (!['draft', 'paused'].includes(current.status) && (current.status === 'closed' || new Date(current.end_at) <= new Date())) throw fail(409, 'Kỳ thi đã kết thúc nên không thể chỉnh sửa hoặc cấu hình lại.');
      // Sau khi thông báo, chỉ cho đổi trạng thái; thông tin và lịch giữ cố định đến khi quay về bản nháp.
      if (!['draft', 'paused'].includes(current.status) && (current.name !== item.name || (current.description || '') !== item.description || Number(current.duration_minutes) !== item.durationMinutes || Number(current.max_attempts) !== item.maxAttempts || iso(current.start_at) !== iso(item.startAt) || iso(current.end_at) !== iso(item.endAt))) throw fail(409, 'Kỳ thi đang ở trạng thái Thông báo kỳ thi; chỉ có thể thay đổi trạng thái.');
      // Khi mở lại, bù thời gian tạm đóng vào hạn nộp của các bài chưa hoàn thành.
      if (current.status === 'paused' && item.status !== 'paused' && current.paused_at) {
        await tx.query(`UPDATE user_exam_sessions
          SET expires_at=DATE_ADD(expires_at, INTERVAL TIMESTAMPDIFF(SECOND, ?, CURRENT_TIMESTAMP) SECOND)
          WHERE competition_id=? AND status='in_progress'`, [current.paused_at, id]);
      }
      const [[used]] = await tx.query('SELECT id FROM user_exam_sessions WHERE competition_id = ? LIMIT 1', [id]);
      // Giữ nguyên điều kiện thi khi đã phát sinh lượt để thời hạn và hạn mức không thay đổi giữa bài.
      if (used && (Number(current.duration_minutes) !== item.durationMinutes || Number(current.max_attempts) !== item.maxAttempts || iso(current.start_at) !== iso(item.startAt) || iso(current.end_at) !== iso(item.endAt))) throw fail(409, 'Kỳ thi đã có lượt thi; không thể đổi lịch, điểm chuẩn hoặc giới hạn lượt.');
      await tx.query(`UPDATE competitions SET name=?, description=?, start_date=DATE(?), end_date=DATE(?), duration_minutes=?, max_attempts=?, start_at=?, end_at=?,
        paused_at=CASE WHEN ?='paused' AND status<>'paused' THEN CURRENT_TIMESTAMP WHEN status='paused' AND ?<>'paused' THEN NULL ELSE paused_at END, status=? WHERE id=?`, [item.name, item.description, item.startAt, item.endAt, item.durationMinutes, item.maxAttempts, item.startAt, item.endAt, item.status, item.status, item.status, id]);
      await pinPublishedCompetition(tx, id, item.status);
      if (current.status !== item.status) {
        // Tách nhật ký đóng/mở khỏi nhật ký cập nhật chung để quản trị viên dễ đối soát lịch sử kỳ thi.
        const action = item.status === 'published' ? 'competition.open' : ['paused', 'closed'].includes(item.status) ? 'competition.close' : 'competition.status.change';
        await audit(tx, req.user.id, action, 'competition', id, { competitionName: item.name, previousStatus: current.status, nextStatus: item.status });
      }
      await audit(tx, req.user.id, 'competition.update', 'competition', id);
    });
    res.json({ success: true, item: { id, ...item } });
  }));
  router.delete('/competitions/:id', requireRoles('admin'), route(async (req, res) => {
    const id = positiveId(req.params.id, 'Kỳ thi');
    await pool.transaction(async tx => {
      // Khóa kỳ thi để không có đề, lượt thi hoặc đăng ký mới được tạo xen giữa lúc xóa.
      const [[competition]] = await tx.query('SELECT id,status,end_at,CURRENT_TIMESTAMP AS server_now FROM competitions WHERE id=? FOR UPDATE', [id]);
      if (!competition) throw fail(404, 'Kỳ thi không tồn tại.');
      // Đề thi là mốc dữ liệu đã được cấu hình; không xóa kỳ thi để tránh mất đề và lịch sử liên quan.
      // K? thi ?? k?t th?c ph?i ???c x?c nh?n r? r?ng tr??c khi x?a to?n b? d? li?u.
      const ended = competition.status === 'closed' || (competition.end_at && new Date(competition.end_at) <= new Date(competition.server_now));
      // M?i tr?ng th?i ??u c?n x?c nh?n b?ng ch? v? thao t?c x?a lo?i b? to?n b? d? li?u li?n quan.
      if (String(req.body?.confirmation || '').trim().toLocaleLowerCase('vi') !== 'xoa') {
        throw fail(400, 'Nh?p ?xoa? ?? x?c nh?n x?a k? thi.');
      }
      // ?? thi ch? ng?n x?a c?c k? thi ?ang ho?t ??ng; k? thi ?? k?t th?c ???c x?a sau x?c nh?n.
      const [[exam]] = await tx.query('SELECT id FROM exams WHERE competition_id=? LIMIT 1', [id]);
      if (exam && !['draft', 'paused'].includes(competition.status) && !ended) throw fail(409, 'K? thi ?? c? ?? thi n?n kh?ng th? x?a. H?y ??a k? thi v? B?n nh?p ho?c T?m ??ng n?u c?n x?a ?? c?u h?nh l?i.');
      // Kỳ thi chưa có đề chỉ còn dữ liệu cấu hình, có thể xóa theo thứ tự khóa ngoại.
      await tx.query(`DELETE r FROM results r
        LEFT JOIN user_exam_sessions s ON s.id=r.session_id
        LEFT JOIN exams e ON e.id=r.exam_id
        WHERE s.competition_id=? OR e.competition_id=?`, [id, id]);
      await tx.query(`DELETE s FROM user_exam_sessions s
        LEFT JOIN exams e ON e.id=s.exam_id
        WHERE s.competition_id=? OR e.competition_id=?`, [id, id]);
      await tx.query('DELETE FROM exam_questions WHERE exam_id IN (SELECT id FROM exams WHERE competition_id=?)', [id]);
      await tx.query('DELETE FROM exams WHERE competition_id=?', [id]);
      await tx.query('DELETE FROM questions WHERE competition_id=? OR round_id IN (SELECT id FROM rounds WHERE competition_id=?)', [id, id]);
      await tx.query('DELETE FROM competition_registrations WHERE competition_id=?', [id]);
      await tx.query('DELETE FROM teacher_competitions WHERE competition_id=?', [id]);
      await tx.query('DELETE FROM rounds WHERE competition_id=?', [id]);
      await tx.query('UPDATE site_settings SET pinned_competition_id=NULL WHERE pinned_competition_id=?', [id]);
      await tx.query('DELETE FROM competitions WHERE id=?', [id]);
      await audit(tx, req.user.id, 'competition.delete', 'competition', id);
    });
    res.json({ success: true, message: 'Đã xóa kỳ thi và dữ liệu cấu hình liên quan.' });
  }));
  router.get('/competitions/:id/rounds', route(async (req, res) => {
    const competitionId = positiveId(req.params.id, 'Kỳ thi');
    await assertCompetitionAccess(pool, req.user, competitionId, 'questions');
    const [items] = await pool.query('SELECT id,competition_id,name,round_number,duration_minutes,duration_seconds,advance_count,enabled,finalized_at,start_datetime,end_datetime FROM rounds WHERE competition_id=? ORDER BY round_number', [competitionId]);
    res.json({ success: true, items: items.map(roundPayload) });
  }));
  router.post('/competitions/:id/rounds', requireRoles('admin'), route(async (req, res) => {
    const competitionId = positiveId(req.params.id, 'Kỳ thi');
    const [[competition]] = await pool.query('SELECT id,start_at,end_at,status FROM competitions WHERE id=?', [competitionId]);
    if (!competition) throw fail(404, 'Kỳ thi không tồn tại.');
    if (!['draft', 'paused'].includes(competition.status)) throw fail(409, 'Chỉ có thể cấu hình vòng khi kỳ thi ở trạng thái Bản nháp hoặc Tạm đóng.');
    const item = roundInput(req.body, competition);
    const id = await pool.transaction(async tx => {
      const [[existing]] = await tx.query('SELECT id FROM rounds WHERE competition_id=? AND round_number=?', [competitionId, item.roundNumber]);
      if (existing) throw fail(409, 'Số vòng đã tồn tại trong kỳ thi.');
      await assertRoundSequence(tx, competitionId, item);
      // Giao diện chưa có thao tác tắt vòng, vì vậy vòng vừa tạo phải được bật ngay.
      const [result] = await tx.query('INSERT INTO rounds (competition_id,name,round_number,duration_minutes,duration_seconds,advance_count,enabled,start_datetime,end_datetime) VALUES (?,?,?,?,?,?,?,?,?)', [competitionId, item.name, item.roundNumber, item.durationMinutes, item.durationSeconds, item.advanceCount, 1, item.startAt, item.endAt]);
      await audit(tx, req.user.id, 'round.create', 'round', result.insertId);
      return result.insertId;
    });
    res.status(201).json({ success: true, item: { id, competitionId, ...item, enabled: true, finalized: false } });
  }));
  router.put('/competitions/:competitionId/rounds/:id', requireRoles('admin'), route(async (req, res) => {
    const competitionId = positiveId(req.params.competitionId, 'Kỳ thi'), roundId = positiveId(req.params.id, 'Vòng thi');
    const [[competition]] = await pool.query('SELECT id,start_at,end_at,status FROM competitions WHERE id=?', [competitionId]);
    const [[current]] = await pool.query('SELECT id FROM rounds WHERE id=? AND competition_id=?', [roundId, competitionId]);
    if (!competition || !current) throw fail(404, 'Không tìm thấy kỳ thi hoặc vòng thi.');
    if (!['draft', 'paused'].includes(competition.status)) throw fail(409, 'Chỉ có thể cấu hình vòng khi kỳ thi ở trạng thái Bản nháp hoặc Tạm đóng.');
    const item = roundInput(req.body, competition);
    await pool.transaction(async tx => {
      const [[existing]] = await tx.query('SELECT id FROM rounds WHERE competition_id=? AND round_number=? AND id<>?', [competitionId, item.roundNumber, roundId]);
      if (existing) throw fail(409, 'Số vòng đã tồn tại trong kỳ thi.');
      await assertRoundSequence(tx, competitionId, item, roundId);
      await tx.query('UPDATE rounds SET name=?,round_number=?,duration_minutes=?,duration_seconds=?,advance_count=?,start_datetime=?,end_datetime=? WHERE id=? AND competition_id=?', [item.name, item.roundNumber, item.durationMinutes, item.durationSeconds, item.advanceCount, item.startAt, item.endAt, roundId, competitionId]);
      await audit(tx, req.user.id, 'round.update', 'round', roundId);
    });
    res.json({ success: true, item: { id: roundId, competitionId, ...item, enabled: true, finalized: false } });
  }));
  router.get('/competitions/:competitionId/rounds/:id/rankings', route(async (req, res) => {
    const competitionId = positiveId(req.params.competitionId, 'Kỳ thi');
    const roundId = positiveId(req.params.id, 'Vòng thi');
    await assertCompetitionAccess(pool, req.user, competitionId, 'exams');
    const [[round]] = await pool.query('SELECT finalized_at,round_number FROM rounds WHERE id=? AND competition_id=?', [roundId, competitionId]);
    if (!round) throw fail(404, 'Không tìm thấy vòng thi.');
    // Trước khi chốt, quản trị viên vẫn xem được bảng xếp hạng tạm tính từ các bài đã nộp.
    // Cờ đi tiếp chỉ có giá trị chính thức sau khi worker chốt vòng.
    const [rows] = await pool.query(`SELECT r.id,r.user_id,u.hoten,r.score,r.duration_seconds,r.duration_seconds AS durationSeconds,r.finished_at,r.round_rank AS roundRank,r.advanced
      FROM results r
      JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id AND s.exam_id=r.exam_id
      JOIN users u ON u.id=r.user_id
      WHERE s.competition_id=? AND s.round_id=? AND r.duration_seconds IS NOT NULL AND r.finished_at>=r.started_at
      AND s.status IN ('submitted','expired')
      ORDER BY r.id`, [competitionId, roundId]);
    const finalized = Boolean(round.finalized_at);
    // Khi đã chốt, chỉ các bản ghi được chốt hạng mới là lượt đại diện của thí sinh.
    // Khi chưa chốt, rankResults tự chọn một lượt tốt nhất cho mỗi thí sinh.
    let ranked = finalized ? rows.filter(item => item.roundRank !== null && item.roundRank !== undefined).sort((a, b) => Number(a.roundRank) - Number(b.roundRank) || Number(a.id) - Number(b.id)) : rankResults(rows);
    if (finalized) {
      // Khi tổng kết, giữ cả thí sinh đã đủ điều kiện vào vòng nhưng không mở bài.
      // Các bản ghi này chỉ dùng để hiển thị điểm 0, không tạo lượt thi giả trong database.
      const [eligible] = Number(round.round_number) === 1
        ? await pool.query(`SELECT cr.user_id AS userId,u.hoten FROM competition_registrations cr
          JOIN users u ON u.id=cr.user_id WHERE cr.competition_id=? ORDER BY u.hoten,u.id`, [competitionId])
        : await pool.query(`SELECT DISTINCT r.user_id AS userId,u.hoten FROM results r
          JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
          JOIN users u ON u.id=r.user_id JOIN rounds previousRound ON previousRound.id=s.round_id
          WHERE s.competition_id=? AND previousRound.round_number<? AND r.advanced=1 ORDER BY u.hoten,userId`, [competitionId, round.round_number]);
      const completedUsers = new Set(ranked.map(item => String(item.user_id)));
      const absent = eligible.filter(item => !completedUsers.has(String(item.userId))).map((item, index) => ({
        id: `absent-${item.userId}`, user_id: item.userId, hoten: item.hoten, score: 0,
        durationSeconds: null, roundRank: ranked.length + index + 1, advanced: 0, noAttempt: true
      }));
      ranked = [...ranked, ...absent];
    }
    res.json({ success: true, finalized, items: ranked.map((item, index) => ({
      id: item.id, hoten: item.hoten, score: Number(item.score), durationSeconds: item.durationSeconds == null ? null : Number(item.durationSeconds),
      roundRank: finalized ? Number(item.roundRank) : index + 1,
      advanced: finalized ? Boolean(Number(item.advanced)) : null
    })) });
  }));
  router.delete('/competitions/:competitionId/rounds/:id', requireRoles('admin'), route(async (req, res) => {
    const competitionId = positiveId(req.params.competitionId, 'Kỳ thi'), roundId = positiveId(req.params.id, 'Vòng thi');
    await assertCompetitionDraft(pool, competitionId);
    const [[used]] = await pool.query('SELECT id FROM exams WHERE round_id=? LIMIT 1', [roundId]);
    if (used) throw fail(409, 'Vòng thi đã có đề; không thể xóa.');
    const [result] = await pool.query('DELETE FROM rounds WHERE id=? AND competition_id=?', [roundId, competitionId]);
    if (!result.affectedRows) throw fail(404, 'Không tìm thấy vòng thi.');
    await audit(pool, req.user.id, 'round.delete', 'round', roundId);
    res.json({ success: true, message: 'Đã xóa vòng thi.' });
  }));
  router.get('/questions/template', route(async (req, res) => {
    requirePermission(req.user, 'questions');
    const workbook = new ExcelJS.Workbook();
    const questionKeys = ['sequence', 'content', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'difficulty', 'points'];
    const sheet = styledSheet(workbook, 'Cau hoi', QUESTION_HEADERS.map((header, index) => ({ header, key: questionKeys[index], width: index === 1 ? 65 : index === 0 ? 8 : 24 })));
    // Ba dòng mẫu giúp người nhập nhận biết chính xác ba giá trị độ khó bằng tiếng Việt.
    sheet.addRows([
      { sequence: 1, content: 'Một tuần có bao nhiêu ngày?', optionA: '5', optionB: '6', optionC: '7', optionD: '8', correctAnswer: 'C', difficulty: 'Dễ' },
      { sequence: 2, content: 'Việt Nam có bao nhiêu tỉnh, thành phố trực thuộc trung ương?', optionA: '61', optionB: '62', optionC: '63', optionD: '64', correctAnswer: 'C', difficulty: 'Trung bình' },
      { sequence: 3, content: 'Ngày thành lập Đoàn TNCS Hồ Chí Minh là ngày nào?', optionA: '26/3/1930', optionB: '26/3/1931', optionC: '2/9/1945', optionD: '19/5/1890', correctAnswer: 'B', difficulty: 'Khó' }
    ]);
    await sendWorkbook(res, workbook, 'mau-ngan-hang-cau-hoi.xlsx');
  }));
  // Kiểm tra quyền trước khi nhận và giải nén tệp.
  const authorizeImport = (req, _res, next) => Promise.resolve().then(async () => {
    const competitionId = positiveId(req.query.competitionId, 'Kỳ thi');
    await assertCompetitionAccess(pool, req.user, competitionId, 'questions');
    await assertCompetitionDraft(pool, competitionId);
  }).then(() => next(), next);
  router.post('/questions/import', authorizeImport, upload.single('file'), route(async (req, res) => {
    const competitionId = positiveId(req.query.competitionId);
    const roundId = positiveId(req.query.roundId, 'Vòng thi');
    const rows = await readQuestionWorkbook(req.file);
    const items = rows.map(row => { try { return validateQuestion({ ...row, competitionId, roundId }); } catch (error) { throw fail(400, `Dòng ${row.row}: ${error.message}`); } });
    await assertQuestionRound(pool, items[0]);
    await pool.transaction(async tx => {
      for (const item of items) await insertQuestion(tx, item, req.user.id);
      await audit(tx, req.user.id, 'questions.import', 'competition', competitionId);
    });
    res.status(201).json({ success: true, count: items.length, message: `Đã nhập ${items.length} câu hỏi.` });
  }));
  router.get('/questions', route(async (req, res) => {
    const values = [], clauses = ['q.archived_at IS NULL', scopedWhere(req.user, 'q.competition_id', 'questions', values)];
    if (req.query.competitionId) { clauses.push('q.competition_id = ?'); values.push(positiveId(req.query.competitionId)); }
    if (req.query.roundId) { clauses.push('q.round_id = ?'); values.push(positiveId(req.query.roundId, 'Vòng thi')); }
    if (req.query.q) { clauses.push('q.content LIKE ?'); values.push(`%${textField(req.query.q, 'Từ khóa', 200)}%`); }
    if (req.query.difficulty) { clauses.push('q.difficulty = ?'); values.push(textField(req.query.difficulty, 'Độ khó', 20)); }
    const page = integer(req.query.page || 1, 'Trang', 1, 1000000), pageSize = integer(req.query.pageSize || 100, 'Số dòng', 1, 500);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM questions q WHERE ${clauses.join(' AND ')}`, values);
    const [items] = await pool.query(`SELECT ${questionColumns} FROM questions q WHERE ${clauses.join(' AND ')} ORDER BY q.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    res.json({ success: true, items, total: Number(total), page, pageSize });
  }));
  router.get('/questions/:id', route(async (req, res) => {
    const [[item]] = await pool.query(`SELECT ${questionColumns} FROM questions q WHERE q.id = ? AND q.archived_at IS NULL`, [positiveId(req.params.id)]);
    if (!item) throw fail(404, 'Không tìm thấy câu hỏi.');
    await assertCompetitionAccess(pool, req.user, item.competitionId, 'questions');
    res.json({ success: true, item });
  }));
  router.post('/questions', route(async (req, res) => {
    const item = validateQuestion(req.body);
    await assertCompetitionAccess(pool, req.user, item.competitionId, 'questions');
    await assertCompetitionDraft(pool, item.competitionId);
    await assertQuestionRound(pool, item);
    const id = await pool.transaction(async tx => { const id = await insertQuestion(tx, item, req.user.id); await audit(tx, req.user.id, 'question.create', 'question', id); return id; });
    res.status(201).json({ success: true, item: { id, ...item } });
  }));
  router.put('/questions/:id', route(async (req, res) => {
    const id = positiveId(req.params.id), item = validateQuestion(req.body);
    await pool.transaction(async tx => {
      const [[current]] = await tx.query('SELECT * FROM questions WHERE id=? AND archived_at IS NULL FOR UPDATE', [id]);
      if (!current) throw fail(404, 'Không tìm thấy câu hỏi.');
      await assertCompetitionAccess(tx, req.user, current.competition_id, 'questions');
      await assertCompetitionAccess(tx, req.user, item.competitionId, 'questions');
      await assertCompetitionDraft(tx, current.competition_id);
      if (Number(current.competition_id) !== item.competitionId) await assertCompetitionDraft(tx, item.competitionId);
      await assertQuestionRound(tx, item);
      await tx.query('UPDATE questions SET competition_id=?, round_id=?, content=?, optionA=?, optionB=?, optionC=?, optionD=?, correctAnswer=?, difficulty=?, points=? WHERE id=?', [...questionValues(item), id]);
      await audit(tx, req.user.id, 'question.update', 'question', id);
    });
    res.json({ success: true, item: { id, ...item } });
  }));
  router.delete('/questions/:id', route(async (req, res) => {
    const id = positiveId(req.params.id);
    await pool.transaction(async tx => {
      const [[current]] = await tx.query('SELECT * FROM questions WHERE id=? AND archived_at IS NULL FOR UPDATE', [id]);
      if (!current) throw fail(404, 'Không tìm thấy câu hỏi.');
      await assertCompetitionAccess(tx, req.user, current.competition_id, 'questions');
      await assertCompetitionDraft(tx, current.competition_id);
      // Xóa mềm giữ liên kết lịch sử; các đề đã xác nhận vẫn dùng bản sao riêng của chúng.
      await tx.query('UPDATE questions SET archived_at=NOW() WHERE id=?', [id]);
      await audit(tx, req.user.id, 'question.archive', 'question', id);
    });
    res.json({ success: true, message: 'Đã xóa câu hỏi khỏi ngân hàng đang sử dụng.' });
  }));
  router.post('/exams/preview', route(async (req, res) => {
    const competitionId = positiveId(req.body.competitionId), count = integer(req.body.count, 'Số câu', 1, 200), quantity = integer(req.body.quantity || 1, 'Số đề', 1, 20);
    const hardCount = integer(req.body.hardCount ?? 0, 'Số câu khó', 0, count), mediumCount = integer(req.body.mediumCount ?? 0, 'Số câu trung bình', 0, count);
    if (hardCount + mediumCount > count) throw fail(400, 'Tổng số câu khó và trung bình không được vượt quá số câu trong đề.');
    await assertCompetitionAccess(pool, req.user, competitionId, 'exams');
    await assertCompetitionDraft(pool, competitionId);
    // Nếu kỳ thi đã cấu hình vòng, đề phải được tạo cho đúng một vòng đang bật.
    const round = await roundScope(pool, competitionId, req.body.roundId);
    const values = [competitionId, round.id], filters = ['q.competition_id=?', 'q.round_id=?', 'q.archived_at IS NULL'];
    if (req.body.difficulty) { filters.push('q.difficulty=?'); values.push(textField(req.body.difficulty, 'Độ khó', 20)); }
    const [questions] = await pool.query(`SELECT ${questionColumns} FROM questions q WHERE ${filters.join(' AND ')} ORDER BY q.id`, values);
    const randomQuestions = source => {
      const available = [...source];
      for (let i = available.length - 1; i > 0; i -= 1) { const j = randomInt(i + 1); [available[i], available[j]] = [available[j], available[i]]; }
      return available;
    };
    const easyCount = count - hardCount - mediumCount;
    // Khi không cấu hình cơ cấu, giữ cách chọn ngẫu nhiên từ toàn bộ các mức độ khó.
    if (!hardCount && !mediumCount && questions.length < count) throw fail(409, `Chỉ có ${questions.length} câu phù hợp, cần ${count} câu.`, 'INSUFFICIENT_QUESTIONS');
    const byDifficulty = Object.groupBy(questions, item => item.difficulty);
    for (const [difficulty, required, label] of [['hard', hardCount, 'khó'], ['medium', mediumCount, 'trung bình'], ['easy', easyCount, 'dễ']]) {
      if ((hardCount || mediumCount) && (byDifficulty[difficulty] || []).length < required) throw fail(409, `Không đủ câu ${label}: cần ${required}, hiện có ${(byDifficulty[difficulty] || []).length}.`, 'INSUFFICIENT_QUESTIONS');
    }
    // Xáo trộn không hoàn lại trong từng đề; nhiều mã đề có thể dùng chung câu từ ngân hàng.
    const items = Array.from({ length: quantity }, (_, index) => {
      const selected = hardCount || mediumCount
        ? [...randomQuestions(byDifficulty.hard || []).slice(0, hardCount), ...randomQuestions(byDifficulty.medium || []).slice(0, mediumCount), ...randomQuestions(byDifficulty.easy || []).slice(0, easyCount)]
        : randomQuestions(questions).slice(0, count);
      return { name: `Đề ${index + 1}`, questions: randomQuestions(selected).map(snapshot) };
    });
    res.json({ success: true, items });
  }));
  router.post('/exams', route(async (req, res) => {
    const competitionId = positiveId(req.body.competitionId);
    await assertCompetitionAccess(pool, req.user, competitionId, 'exams');
    await assertCompetitionDraft(pool, competitionId);
    const round = await roundScope(pool, competitionId, req.body.roundId);
    if (!Array.isArray(req.body.items) || req.body.items.length < 1 || req.body.items.length > 20) throw fail(400, 'Mỗi lần lưu từ 1 đến 20 đề.');
    const drafts = req.body.items.map(item => {
      if (!item || !Array.isArray(item.questionIds) || item.questionIds.length < 1 || item.questionIds.length > 200) throw fail(400, 'Mỗi đề cần từ 1 đến 200 câu.');
      const ids = item.questionIds.map(id => positiveId(id));
      if (new Set(ids).size !== ids.length) throw fail(400, 'Một đề không được có câu hỏi trùng.');
      // Tên đề không còn do người dùng nhập; mã đề là định danh hiển thị duy nhất.
      return { ids };
    });
    const items = await pool.transaction(async tx => {
      const [[competition]] = await tx.query('SELECT * FROM competitions WHERE id=? FOR UPDATE', [competitionId]);
      if (!competition) throw fail(404, 'Kỳ thi không tồn tại.');
      // Lượt thi chỉ khóa ngân hàng đề của chính vòng đó. Những vòng khác vẫn có thể được chuẩn bị tiếp.
      const [[used]] = await tx.query('SELECT id FROM user_exam_sessions WHERE competition_id=? AND round_id=? LIMIT 1', [competitionId, round.id]);
      if (used) throw fail(409, 'Vòng thi đã có lượt làm bài; không thể bổ sung đề cho vòng này.', 'ROUND_HAS_ATTEMPTS');
      const saved = [];
      for (const draft of drafts) {
        const [rows] = await tx.query(`SELECT ${questionColumns} FROM questions q WHERE q.competition_id=? AND q.round_id=? AND q.archived_at IS NULL AND q.id IN (${draft.ids.map(() => '?').join(',')}) FOR UPDATE`, [competitionId, round.id, ...draft.ids]);
        if (rows.length !== draft.ids.length) throw fail(409, 'Một số câu hỏi đã bị xóa hoặc không thuộc vòng thi. Hãy tạo lại bản xem trước.');
        const byId = new Map(rows.map(row => [Number(row.id), row]));
        const questions = draft.ids.map(id => snapshot(byId.get(id))), code = randomUUID().slice(0, 8).toUpperCase(), name = `Đề ${code}`;
        // Chỉ lấy nội dung và đáp án từ database, bỏ qua mọi đáp án được gửi từ trình duyệt.
        const [result] = await tx.query('INSERT INTO exams (name, description, takingtime, competition_id, round_id, code, question_snapshot, is_published, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)', [name, '', round?.duration_minutes || competition.duration_minutes, competitionId, round?.id || null, code, JSON.stringify(questions), req.user.id]);
        for (const id of draft.ids) await tx.query('INSERT INTO exam_questions (exam_id, question_id) VALUES (?, ?)', [result.insertId, id]);
        await audit(tx, req.user.id, 'exam.publish', 'exam', result.insertId);
        saved.push({ id: result.insertId, name: draft.name, code, questionCount: questions.length, isPublished: true });
      }
      return saved;
    });
    res.status(201).json({ success: true, items });
  }));
  router.get('/exams', route(async (req, res) => {
    const values = [], clauses = [scopedWhere(req.user, 'e.competition_id', 'exams', values)];
    if (req.query.competitionId) { clauses.push('e.competition_id=?'); values.push(positiveId(req.query.competitionId)); }
    if (req.query.roundId) { clauses.push('e.round_id=?'); values.push(positiveId(req.query.roundId, 'Vòng thi')); }
    const [items] = await pool.query(`SELECT e.id,e.name,e.code,e.competition_id AS competitionId,e.is_published AS isPublished,COALESCE(JSON_LENGTH(e.question_snapshot),0) AS questionCount FROM exams e WHERE ${clauses.join(' AND ')} ORDER BY e.id DESC`, values);
    res.json({ success: true, items: items.map(item => ({ ...item, isPublished: Number(item.isPublished) === 1, questionCount: Number(item.questionCount) })) });
  }));
  router.delete('/exams/:id', route(async (req, res) => {
    const examId = positiveId(req.params.id, 'Đề thi');
    await pool.transaction(async tx => {
      // Khóa đề và kỳ thi để không có lượt thi mới xuất hiện giữa lúc kiểm tra rồi xóa.
      const [[exam]] = await tx.query('SELECT id,competition_id,round_id FROM exams WHERE id=? FOR UPDATE', [examId]);
      if (!exam) throw fail(404, 'Không tìm thấy đề thi.');
      await assertCompetitionAccess(tx, req.user, exam.competition_id, 'exams');
      await assertCompetitionDraft(tx, exam.competition_id);
      await tx.query('SELECT id FROM competitions WHERE id=? FOR UPDATE', [exam.competition_id]);
      const [sessions] = await tx.query(`SELECT id FROM user_exam_sessions WHERE competition_id=?
        AND (${exam.round_id === null ? 'round_id IS NULL' : 'round_id=?'}) LIMIT 1`, exam.round_id === null ? [exam.competition_id] : [exam.competition_id, exam.round_id]);
      if (sessions.length) throw fail(409, 'Vòng thi đã có lượt làm bài; không thể xóa đề.', 'ROUND_HAS_ATTEMPTS');
      // Chỉ xóa liên kết thuộc đề; câu hỏi trong ngân hàng vẫn có thể được dùng để tạo đề khác.
      await tx.query('DELETE FROM exam_questions WHERE exam_id=?', [examId]);
      await tx.query('DELETE FROM exams WHERE id=?', [examId]);
      await audit(tx, req.user.id, 'exam.delete', 'exam', examId);
    });
    res.json({ success: true, message: 'Đã xóa đề thi. Ngân hàng câu hỏi được giữ nguyên.' });
  }));
  router.get('/candidates', route(async (req, res) => {
    const values = [], clauses = [scopedWhere(req.user, 'r.competition_id', 'candidates', values), "u.role='candidate'"];
    if (req.query.competitionId) { clauses.push('r.competition_id=?'); values.push(positiveId(req.query.competitionId)); }
    if (req.query.unitId) { clauses.push('r.unit_id=?'); values.push(positiveId(req.query.unitId)); }
    if (req.query.q) { const q = `%${textField(req.query.q, 'Từ khóa', 200)}%`; clauses.push('(u.hoten LIKE ? OR u.dienthoai LIKE ? OR u.email LIKE ?)'); values.push(q, q, q); }
    const page = integer(req.query.page || 1, 'Trang', 1, 1000000), pageSize = integer(req.query.pageSize || 100, 'Số dòng', 1, 500);
    const joins = 'FROM users u JOIN competition_registrations r ON r.user_id=u.id JOIN competitions c ON c.id=r.competition_id LEFT JOIN donvi d ON d.id=r.unit_id';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${joins} WHERE ${clauses.join(' AND ')}`, values);
    const [items] = await pool.query(`SELECT u.id,u.hoten,u.dienthoai,u.email,d.ten AS unitName,c.name AS competitionName,r.registered_at AS registeredAt ${joins} WHERE ${clauses.join(' AND ')} ORDER BY r.registered_at DESC,u.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    res.json({ success: true, items, total: Number(total), page, pageSize });
  }));
  router.use(createUserManagementRouter({ pool }));
  return router;
}
