import { Router } from 'express';
import { randomInt, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createAccess, requireRoles, assertCompetitionAccess } from './access.js';
import { audit, fail, integer, iso, positiveId, requirePermission, route, textField } from './http.js';
import { QUESTION_HEADERS, readQuestionWorkbook, sendWorkbook, styledSheet, upload } from './files.js';
import { createUserManagementRouter } from './manage-users.js';

const questionColumns = 'q.id, q.competition_id AS competitionId, q.content, q.optionA, q.optionB, q.optionC, q.optionD, q.correctAnswer, q.topic, q.difficulty';
export const competitionPayload = row => ({ id: row.id, name: row.name, description: row.description || '', durationMinutes: Number(row.duration_minutes), maxAttempts: Number(row.max_attempts), startAt: iso(row.start_at), endAt: iso(row.end_at), status: row.status });

export function validateQuestion(body) {
  const item = { competitionId: positiveId(body.competitionId, 'Kỳ thi') };
  for (const key of ['content', 'optionA', 'optionB', 'optionC', 'optionD']) item[key] = textField(body[key], key === 'content' ? 'Nội dung câu hỏi' : `Phương án ${key.at(-1)}`, key === 'content' ? 10000 : 4000);
  if (!['A', 'B', 'C', 'D'].includes(body.correctAnswer)) throw fail(400, 'Đáp án đúng phải là A, B, C hoặc D.');
  item.correctAnswer = body.correctAnswer;
  item.topic = textField(body.topic || 'Chung', 'Chủ đề', 120);
  item.difficulty = body.difficulty || 'medium';
  if (!['easy', 'medium', 'hard'].includes(item.difficulty)) throw fail(400, 'Độ khó phải là easy, medium hoặc hard.');
  return item;
}
const questionValues = item => [item.competitionId, item.content, item.optionA, item.optionB, item.optionC, item.optionD, item.correctAnswer, item.topic, item.difficulty];
const snapshot = q => Object.fromEntries(['id', 'content', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'topic', 'difficulty'].map(key => [key, q[key]]));
async function insertQuestion(db, item, actor) {
  const [result] = await db.query('INSERT INTO questions (competition_id, content, optionA, optionB, optionC, optionD, correctAnswer, topic, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...questionValues(item), actor]);
  return result.insertId;
}
function competitionInput(body) {
  const startAt = new Date(body.startAt), endAt = new Date(body.endAt);
  if (typeof body.startAt !== 'string' || typeof body.endAt !== 'string' || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) throw fail(400, 'Cần thời gian bắt đầu và kết thúc hợp lệ; kết thúc phải sau bắt đầu.');
  const status = body.status || 'draft';
  if (!['draft', 'published', 'closed'].includes(status)) throw fail(400, 'Trạng thái kỳ thi không hợp lệ.');
  return { name: textField(body.name, 'Tên kỳ thi'), description: textField(body.description, 'Mô tả', 10000, true), durationMinutes: integer(body.durationMinutes, 'Thời lượng', 1, 600), maxAttempts: integer(body.maxAttempts, 'Số lượt thi', 1, 100), startAt, endAt, status };
}
function scopedWhere(user, alias, permission, values) {
  requirePermission(user, permission);
  if (user.role === 'admin') return '1=1';
  values.push(user.id);
  return `EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id = ${alias} AND tc.user_id = ?)`;
}

export function createManageRouter({ pool }) {
  const router = Router();
  router.use(createAccess({ pool }), requireRoles('teacher', 'admin'));
  router.get('/competitions', route(async (req, res) => {
    const values = [];
    const where = req.user.role === 'admin' ? '1=1' : (values.push(req.user.id), 'EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id = c.id AND tc.user_id = ?)');
    const [rows] = await pool.query(`SELECT c.* FROM competitions c WHERE ${where} ORDER BY c.id DESC`, values);
    res.json({ success: true, items: rows.map(competitionPayload) });
  }));
  router.post('/competitions', requireRoles('admin'), route(async (req, res) => {
    const item = competitionInput(req.body);
    const id = await pool.transaction(async tx => {
      const [result] = await tx.query('INSERT INTO competitions (name, description, start_date, end_date, duration_minutes, max_attempts, start_at, end_at, status, created_by) VALUES (?, ?, DATE(?), DATE(?), ?, ?, ?, ?, ?, ?)', [item.name, item.description, item.startAt, item.endAt, item.durationMinutes, item.maxAttempts, item.startAt, item.endAt, item.status, req.user.id]);
      await audit(tx, req.user.id, 'competition.create', 'competition', result.insertId);
      return result.insertId;
    });
    res.status(201).json({ success: true, item: { id, ...item } });
  }));
  router.put('/competitions/:id', requireRoles('admin'), route(async (req, res) => {
    const id = positiveId(req.params.id), item = competitionInput(req.body);
    await pool.transaction(async tx => {
      const [[current]] = await tx.query('SELECT * FROM competitions WHERE id = ? FOR UPDATE', [id]);
      if (!current) throw fail(404, 'Kỳ thi không tồn tại.');
      const [[used]] = await tx.query('SELECT id FROM user_exam_sessions WHERE competition_id = ? LIMIT 1', [id]);
      // Giữ nguyên điều kiện thi khi đã phát sinh lượt để thời hạn và hạn mức không thay đổi giữa bài.
      if (used && (Number(current.duration_minutes) !== item.durationMinutes || Number(current.max_attempts) !== item.maxAttempts || iso(current.start_at) !== iso(item.startAt) || iso(current.end_at) !== iso(item.endAt))) throw fail(409, 'Kỳ thi đã có lượt thi; không thể đổi lịch, thời lượng hoặc giới hạn lượt.');
      await tx.query('UPDATE competitions SET name=?, description=?, start_date=DATE(?), end_date=DATE(?), duration_minutes=?, max_attempts=?, start_at=?, end_at=?, status=? WHERE id=?', [item.name, item.description, item.startAt, item.endAt, item.durationMinutes, item.maxAttempts, item.startAt, item.endAt, item.status, id]);
      await audit(tx, req.user.id, 'competition.update', 'competition', id);
    });
    res.json({ success: true, item: { id, ...item } });
  }));
  router.get('/questions/template', route(async (req, res) => {
    requirePermission(req.user, 'questions');
    const workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Cau hoi', QUESTION_HEADERS.map(key => ({ header: key, key, width: key === 'content' ? 65 : 24 })));
    sheet.addRow({ content: 'Một tuần có bao nhiêu ngày?', optionA: '5', optionB: '6', optionC: '7', optionD: '8', correctAnswer: 'C', topic: 'Kiến thức chung', difficulty: 'easy' });
    await sendWorkbook(res, workbook, 'mau-ngan-hang-cau-hoi.xlsx');
  }));
  // Kiểm tra quyền trước khi nhận và giải nén tệp.
  const authorizeImport = (req, _res, next) => Promise.resolve().then(() => assertCompetitionAccess(pool, req.user, positiveId(req.query.competitionId, 'Kỳ thi'), 'questions')).then(() => next(), next);
  router.post('/questions/import', authorizeImport, upload.single('file'), route(async (req, res) => {
    const competitionId = positiveId(req.query.competitionId);
    const rows = await readQuestionWorkbook(req.file);
    const items = rows.map(row => { try { return validateQuestion({ ...row, competitionId }); } catch (error) { throw fail(400, `Dòng ${row.row}: ${error.message}`); } });
    await pool.transaction(async tx => {
      for (const item of items) await insertQuestion(tx, item, req.user.id);
      await audit(tx, req.user.id, 'questions.import', 'competition', competitionId);
    });
    res.status(201).json({ success: true, count: items.length, message: `Đã nhập ${items.length} câu hỏi.` });
  }));
  router.get('/questions', route(async (req, res) => {
    const values = [], clauses = ['q.archived_at IS NULL', scopedWhere(req.user, 'q.competition_id', 'questions', values)];
    if (req.query.competitionId) { clauses.push('q.competition_id = ?'); values.push(positiveId(req.query.competitionId)); }
    if (req.query.q) { clauses.push('q.content LIKE ?'); values.push(`%${textField(req.query.q, 'Từ khóa', 200)}%`); }
    if (req.query.topic) { clauses.push('q.topic = ?'); values.push(textField(req.query.topic, 'Chủ đề', 120)); }
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
      await tx.query('UPDATE questions SET competition_id=?, content=?, optionA=?, optionB=?, optionC=?, optionD=?, correctAnswer=?, topic=?, difficulty=? WHERE id=?', [...questionValues(item), id]);
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
      // Xóa mềm giữ liên kết lịch sử; các đề đã xác nhận vẫn dùng bản sao riêng của chúng.
      await tx.query('UPDATE questions SET archived_at=NOW() WHERE id=?', [id]);
      await audit(tx, req.user.id, 'question.archive', 'question', id);
    });
    res.json({ success: true, message: 'Đã xóa câu hỏi khỏi ngân hàng đang sử dụng.' });
  }));
  router.post('/exams/preview', route(async (req, res) => {
    const competitionId = positiveId(req.body.competitionId), count = integer(req.body.count, 'Số câu', 1, 200), quantity = integer(req.body.quantity || 1, 'Số đề', 1, 20);
    await assertCompetitionAccess(pool, req.user, competitionId, 'exams');
    const values = [competitionId], filters = ['q.competition_id=?', 'q.archived_at IS NULL'];
    if (req.body.topic) { filters.push('q.topic=?'); values.push(textField(req.body.topic, 'Chủ đề', 120)); }
    if (req.body.difficulty) { filters.push('q.difficulty=?'); values.push(textField(req.body.difficulty, 'Độ khó', 20)); }
    const [questions] = await pool.query(`SELECT ${questionColumns} FROM questions q WHERE ${filters.join(' AND ')} ORDER BY q.id`, values);
    if (questions.length < count) throw fail(409, `Chỉ có ${questions.length} câu phù hợp, cần ${count} câu.`, 'INSUFFICIENT_QUESTIONS');
    // Xáo trộn không hoàn lại trong từng đề; nhiều mã đề có thể dùng chung câu từ ngân hàng.
    const items = Array.from({ length: quantity }, (_, index) => {
      const available = [...questions];
      for (let i = available.length - 1; i > 0; i -= 1) { const j = randomInt(i + 1); [available[i], available[j]] = [available[j], available[i]]; }
      return { name: `Đề ${index + 1}`, questions: available.slice(0, count).map(snapshot) };
    });
    res.json({ success: true, items });
  }));
  router.post('/exams', route(async (req, res) => {
    const competitionId = positiveId(req.body.competitionId);
    await assertCompetitionAccess(pool, req.user, competitionId, 'exams');
    if (!Array.isArray(req.body.items) || req.body.items.length < 1 || req.body.items.length > 20) throw fail(400, 'Mỗi lần lưu từ 1 đến 20 đề.');
    const drafts = req.body.items.map(item => {
      if (!item || !Array.isArray(item.questionIds) || item.questionIds.length < 1 || item.questionIds.length > 200) throw fail(400, 'Mỗi đề cần từ 1 đến 200 câu.');
      const ids = item.questionIds.map(id => positiveId(id));
      if (new Set(ids).size !== ids.length) throw fail(400, 'Một đề không được có câu hỏi trùng.');
      return { name: textField(item.name, 'Tên đề'), ids };
    });
    const items = await pool.transaction(async tx => {
      const [[competition]] = await tx.query('SELECT * FROM competitions WHERE id=? FOR UPDATE', [competitionId]);
      if (!competition) throw fail(404, 'Kỳ thi không tồn tại.');
      const [[used]] = await tx.query('SELECT id FROM user_exam_sessions WHERE competition_id=? LIMIT 1', [competitionId]);
      if (used) throw fail(409, 'Kỳ thi đã có lượt thi; không thể bổ sung đề.');
      const saved = [];
      for (const draft of drafts) {
        const [rows] = await tx.query(`SELECT ${questionColumns} FROM questions q WHERE q.competition_id=? AND q.archived_at IS NULL AND q.id IN (${draft.ids.map(() => '?').join(',')}) FOR UPDATE`, [competitionId, ...draft.ids]);
        if (rows.length !== draft.ids.length) throw fail(409, 'Một số câu hỏi đã bị xóa hoặc không thuộc kỳ thi. Hãy tạo lại bản xem trước.');
        const byId = new Map(rows.map(row => [Number(row.id), row]));
        const questions = draft.ids.map(id => snapshot(byId.get(id))), code = randomUUID().slice(0, 8).toUpperCase();
        // Chỉ lấy nội dung và đáp án từ database, bỏ qua mọi đáp án được gửi từ trình duyệt.
        const [result] = await tx.query('INSERT INTO exams (name, description, takingtime, competition_id, code, question_snapshot, is_published, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', [draft.name, '', competition.duration_minutes, competitionId, code, JSON.stringify(questions), req.user.id]);
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
    const [items] = await pool.query(`SELECT e.id,e.name,e.code,e.competition_id AS competitionId,e.is_published AS isPublished,COALESCE(JSON_LENGTH(e.question_snapshot),0) AS questionCount FROM exams e WHERE ${clauses.join(' AND ')} ORDER BY e.id DESC`, values);
    res.json({ success: true, items: items.map(item => ({ ...item, isPublished: Number(item.isPublished) === 1, questionCount: Number(item.questionCount) })) });
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
