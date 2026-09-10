import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { requireRoles } from './access.js';
import { audit, fail, integer, parseJson, positiveId, route, textField } from './http.js';

const availablePermissions = ['questions', 'exams', 'candidates', 'reports'];
function accessInput(body, creating = false) {
  const roles = creating ? ['candidate', 'teacher'] : ['candidate', 'teacher', 'admin'];
  if (!roles.includes(body.role)) throw fail(400, 'Vai trò không hợp lệ.');
  if (!Array.isArray(body.permissions) || body.permissions.some(p => !availablePermissions.includes(p))) throw fail(400, 'Danh sách quyền không hợp lệ.');
  if (!Array.isArray(body.competitionIds) || body.competitionIds.length > 200) throw fail(400, 'Danh sách kỳ thi không hợp lệ.');
  const competitionIds = [...new Set(body.competitionIds.map(id => positiveId(id, 'Kỳ thi')))];
  if (!creating && ![true, false, 0, 1].includes(body.is_active)) throw fail(400, 'Trạng thái tài khoản không hợp lệ.');
  return { role: body.role, permissions: body.role === 'teacher' ? [...new Set(body.permissions)] : [], competitionIds: body.role === 'teacher' ? competitionIds : [], isActive: creating ? 1 : Number(body.is_active) };
}
async function assignCompetitions(db, userId, ids) {
  if (ids.length) {
    const [rows] = await db.query(`SELECT id FROM competitions WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (rows.length !== ids.length) throw fail(400, 'Một số kỳ thi phân công không tồn tại.');
  }
  await db.query('DELETE FROM teacher_competitions WHERE user_id=?', [userId]);
  for (const id of ids) await db.query('INSERT INTO teacher_competitions (user_id,competition_id) VALUES (?,?)', [userId, id]);
}
export function createUserManagementRouter({ pool }) {
  const router = Router();
  router.get('/units', route(async (_req, res) => {
    const [items] = await pool.query('SELECT d.id,d.ten,o.ten AS organizationName FROM donvi d JOIN doancoso o ON o.id=d.doanCoSoID ORDER BY d.ten');
    res.json({ success: true, items });
  }));
  router.use(requireRoles('admin'));
  router.post('/units', route(async (req, res) => {
    const name = textField(req.body.ten, 'Tên đơn vị'), organization = textField(req.body.organizationName || 'Đơn vị trực thuộc', 'Tên đoàn cơ sở');
    const id = await pool.transaction(async tx => {
      let [[parent]] = await tx.query('SELECT id FROM doancoso WHERE ten=? LIMIT 1', [organization]);
      if (!parent) { const [created] = await tx.query('INSERT INTO doancoso (ten) VALUES (?)', [organization]); parent = { id: created.insertId }; }
      const [[existing]] = await tx.query('SELECT id FROM donvi WHERE ten=? AND doanCoSoID=? LIMIT 1', [name, parent.id]);
      if (existing) throw fail(409, 'Đơn vị đã tồn tại trong đoàn cơ sở này.');
      const [result] = await tx.query('INSERT INTO donvi (ten,doanCoSoID) VALUES (?,?)', [name, parent.id]);
      await audit(tx, req.user.id, 'unit.create', 'unit', result.insertId);
      return result.insertId;
    });
    res.status(201).json({ success: true, item: { id, ten: name, organizationName: organization } });
  }));
  router.get('/users', route(async (req, res) => {
    const values = [], clauses = [];
    if (req.query.q) { const q = `%${textField(req.query.q, 'Từ khóa', 200)}%`; clauses.push('(u.hoten LIKE ? OR u.dienthoai LIKE ? OR u.email LIKE ?)'); values.push(q, q, q); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const page = integer(req.query.page || 1, 'Trang', 1, 1000000), pageSize = integer(req.query.pageSize || 100, 'Số dòng', 1, 500);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users u ${where}`, values);
    const [rows] = await pool.query(`SELECT u.id,u.hoten,u.dienthoai,u.email,u.donviID,u.role,u.permissions,u.is_active,u.must_change_password FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    const ids = rows.map(row => row.id);
    const [assignments] = ids.length ? await pool.query(`SELECT user_id,competition_id FROM teacher_competitions WHERE user_id IN (${ids.map(() => '?').join(',')})`, ids) : [[]];
    const items = rows.map(row => ({ ...row, is_active: Number(row.is_active) === 1, must_change_password: Number(row.must_change_password) === 1, permissions: parseJson(row.permissions, []), competitionIds: assignments.filter(a => Number(a.user_id) === Number(row.id)).map(a => Number(a.competition_id)) }));
    res.json({ success: true, items, total: Number(total), page, pageSize });
  }));
  router.post('/users', route(async (req, res) => {
    const access = accessInput(req.body, true), name = textField(req.body.hoten, 'Họ tên');
    const phone = textField(req.body.dienthoai, 'Số điện thoại', 30).replace(/[\s.-]/g, '');
    const email = textField(req.body.email, 'Email', 254).toLowerCase();
    if (!/^\+?\d{9,15}$/.test(phone) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Số điện thoại hoặc email không hợp lệ.');
    const unit = req.body.donviID ? positiveId(req.body.donviID, 'Đơn vị') : null;
    if (access.role === 'candidate' && !unit) throw fail(400, 'Tài khoản thí sinh cần chọn đơn vị.');
    const temporaryPassword = randomBytes(18).toString('base64url'), hash = await bcrypt.hash(temporaryPassword, 12);
    const id = await pool.transaction(async tx => {
      if (unit) { const [[exists]] = await tx.query('SELECT id FROM donvi WHERE id=?', [unit]); if (!exists) throw fail(400, 'Đơn vị không tồn tại.'); }
      const [result] = await tx.query('INSERT INTO users (hoten,dienthoai,email,donviID,password,is_active,role,permissions,must_change_password) VALUES (?,?,?,?,?,1,?,?,1)', [name, phone, email, unit, hash, access.role, JSON.stringify(access.permissions)]);
      await assignCompetitions(tx, result.insertId, access.competitionIds);
      await audit(tx, req.user.id, 'user.create', 'user', result.insertId);
      return result.insertId;
    });
    // Mật khẩu tạm chỉ xuất hiện trong phản hồi này, không lưu rõ hay ghi nhật ký.
    res.status(201).json({ success: true, item: { id, hoten: name, dienthoai: phone, email, role: access.role }, temporaryPassword });
  }));
  router.put('/users/:id/access', route(async (req, res) => {
    const id = positiveId(req.params.id), access = accessInput(req.body);
    if (id === Number(req.user.id) && (access.role !== 'admin' || !access.isActive)) throw fail(409, 'Bạn không thể tự hạ quyền hoặc khóa tài khoản quản trị đang sử dụng.');
    await pool.transaction(async tx => {
      // Khóa các admin theo cùng thứ tự để hai thao tác đồng thời không vô hiệu hóa admin cuối cùng.
      const [admins] = await tx.query("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY id FOR UPDATE");
      const [[user]] = await tx.query('SELECT id,role,is_active FROM users WHERE id=? FOR UPDATE', [id]);
      if (!user) throw fail(404, 'Tài khoản không tồn tại.');
      if (user.role === 'admin' && Number(user.is_active) === 1 && admins.length <= 1 && (access.role !== 'admin' || !access.isActive)) throw fail(409, 'Hệ thống phải còn ít nhất một quản trị viên hoạt động.');
      await tx.query('UPDATE users SET role=?,permissions=?,is_active=?,token_version=token_version+1 WHERE id=?', [access.role, JSON.stringify(access.permissions), access.isActive, id]);
      await assignCompetitions(tx, id, access.competitionIds);
      await audit(tx, req.user.id, 'user.access.update', 'user', id);
    });
    res.json({ success: true, message: 'Đã cập nhật quyền. Tài khoản cần đăng nhập lại.' });
  }));
  router.get('/password-requests', route(async (_req, res) => {
    const [items] = await pool.query("SELECT r.id,r.user_id AS userId,u.hoten,u.dienthoai,u.email,r.created_at AS createdAt,r.status FROM password_reset_requests r JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 1000");
    res.json({ success: true, items });
  }));
  router.post('/users/:id/reset-password', route(async (req, res) => {
    const id = positiveId(req.params.id), requestId = req.body.requestId ? positiveId(req.body.requestId) : null;
    const temporaryPassword = randomBytes(18).toString('base64url'), hash = await bcrypt.hash(temporaryPassword, 12);
    await pool.transaction(async tx => {
      const [[user]] = await tx.query('SELECT id FROM users WHERE id=? FOR UPDATE', [id]);
      if (!user) throw fail(404, 'Tài khoản không tồn tại.');
      if (requestId) { const [[request]] = await tx.query("SELECT id FROM password_reset_requests WHERE id=? AND user_id=? AND status='pending' FOR UPDATE", [requestId, id]); if (!request) throw fail(409, 'Yêu cầu hỗ trợ không còn chờ xử lý hoặc không thuộc tài khoản này.'); }
      await tx.query('UPDATE users SET password=?,must_change_password=1,token_version=token_version+1 WHERE id=?', [hash, id]);
      await tx.query("UPDATE password_reset_requests SET status='resolved',resolved_at=NOW(),resolved_by=? WHERE user_id=? AND status='pending'", [req.user.id, id]);
      await audit(tx, req.user.id, 'user.password.reset', 'user', id);
    });
    res.json({ success: true, temporaryPassword, message: 'Đã cấp mật khẩu tạm. Yêu cầu người dùng đổi mật khẩu khi đăng nhập.' });
  }));
  return router;
}
