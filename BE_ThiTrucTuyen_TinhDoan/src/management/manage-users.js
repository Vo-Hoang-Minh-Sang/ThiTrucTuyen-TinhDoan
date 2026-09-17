import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { requireRoles } from '../auth/access.js';
import { audit, fail, integer, parseJson, positiveId, route, textField } from '../common/http.js';
import { readCandidateAccountWorkbook, readUnitWorkbook, sendWorkbook, styledSheet, upload } from '../site/files.js';

// Danh sách quyền có thể cấp cho giảng viên; quản trị viên luôn có toàn quyền.
const availablePermissions = ['questions', 'exams', 'candidates', 'reports'];
function accessInput(body, creating = false) {
  // Tách và kiểm tra dữ liệu phân quyền trước khi ghi đồng thời nhiều bảng.
  const roles = creating ? ['candidate', 'teacher'] : ['candidate', 'teacher', 'admin'];
  if (!roles.includes(body.role)) throw fail(400, 'Vai trò không hợp lệ.');
  if (!Array.isArray(body.permissions) || body.permissions.some(p => !availablePermissions.includes(p))) throw fail(400, 'Danh sách quyền không hợp lệ.');
  if (!Array.isArray(body.competitionIds) || body.competitionIds.length > 200) throw fail(400, 'Danh sách kỳ thi không hợp lệ.');
  const competitionIds = [...new Set(body.competitionIds.map(id => positiveId(id, 'Kỳ thi')))];
  if (!creating && ![true, false, 0, 1].includes(body.is_active)) throw fail(400, 'Trạng thái tài khoản không hợp lệ.');
  return { role: body.role, permissions: body.role === 'teacher' ? [...new Set(body.permissions)] : [], competitionIds: body.role === 'teacher' ? competitionIds : [], isActive: creating ? 1 : Number(body.is_active) };
}
async function assignCompetitions(db, userId, ids) {
  // Thay thế toàn bộ danh sách kỳ thi được giao trong cùng giao dịch.
  if (ids.length) {
    const [rows] = await db.query(`SELECT id FROM competitions WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (rows.length !== ids.length) throw fail(400, 'Một số kỳ thi phân công không tồn tại.');
  }
  await db.query('DELETE FROM teacher_competitions WHERE user_id=?', [userId]);
  for (const id of ids) await db.query('INSERT INTO teacher_competitions (user_id,competition_id) VALUES (?,?)', [userId, id]);
}
export function createUserManagementRouter({ pool }) {
  // API quản lý đơn vị, cấp tài khoản, phân quyền và hỗ trợ đặt lại mật khẩu.
  const router = Router();
  router.get('/units', route(async (req, res) => {
    // API công khai vẫn trả toàn bộ đơn vị cho biểu mẫu đăng ký; giao diện quản trị truyền page để nhận từng trang.
    const paginating = Object.hasOwn(req.query, 'page') || Object.hasOwn(req.query, 'pageSize');
    if (!paginating) {
      const [items] = await pool.query('SELECT d.id,d.ten,o.ten AS organizationName FROM donvi d JOIN doancoso o ON o.id=d.doanCoSoID ORDER BY d.ten');
      return res.json({ success: true, items });
    }
    const page = integer(req.query.page || 1, 'Trang', 1, 1000000);
    const pageSize = integer(req.query.pageSize || 10, 'Số dòng', 1, 100);
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM donvi');
    const [items] = await pool.query('SELECT d.id,d.ten,o.ten AS organizationName FROM donvi d JOIN doancoso o ON o.id=d.doanCoSoID ORDER BY d.ten LIMIT ? OFFSET ?', [pageSize, (page - 1) * pageSize]);
    return res.json({ success: true, items, total: Number(total), page, pageSize });
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
  router.get('/units/template', route(async (_req, res) => {
    // Mẫu cố định tên cột để tệp nhập có thể được kiểm tra trước khi ghi vào database.
    const workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Don vi', [
      { header: 'Đơn vị', key: 'ten', width: 42 }, { header: 'Đoàn cơ sở', key: 'organizationName', width: 36 }
    ]);
    sheet.addRows([
      { ten: 'Đoàn xã Minh Khai', organizationName: 'Huyện đoàn Minh Khai' },
      { ten: 'Đoàn trường THPT Minh Khai', organizationName: 'Huyện đoàn Minh Khai' }
    ]);
    await sendWorkbook(res, workbook, 'mau-danh-sach-don-vi.xlsx');
  }));
  router.post('/units/import', upload.single('file'), route(async (req, res) => {
    const rows = await readUnitWorkbook(req.file);
    const result = await pool.transaction(async tx => {
      // Tên đơn vị là tiêu chí duy nhất để bỏ trùng theo yêu cầu, kể cả khác đoàn cơ sở.
      const names = [...new Set(rows.map(item => item.ten.trim()))];
      const [existingRows] = names.length ? await tx.query(`SELECT ten FROM donvi WHERE ten IN (${names.map(() => '?').join(',')})`, names) : [[]];
      const knownNames = new Set(existingRows.map(item => item.ten.trim().toLocaleLowerCase('vi')));
      const importedNames = new Set();
      let added = 0, skipped = 0;
      for (const row of rows) {
        const name = textField(row.ten, 'Tên đơn vị');
        const nameKey = name.toLocaleLowerCase('vi');
        if (knownNames.has(nameKey) || importedNames.has(nameKey)) { skipped += 1; continue; }
        const organization = textField(row.organizationName || 'Đơn vị trực thuộc', 'Tên đoàn cơ sở');
        let [[parent]] = await tx.query('SELECT id FROM doancoso WHERE ten=? LIMIT 1', [organization]);
        if (!parent) { const [created] = await tx.query('INSERT INTO doancoso (ten) VALUES (?)', [organization]); parent = { id: created.insertId }; }
        const [created] = await tx.query('INSERT INTO donvi (ten,doanCoSoID) VALUES (?,?)', [name, parent.id]);
        await audit(tx, req.user.id, 'unit.import', 'unit', created.insertId);
        importedNames.add(nameKey); added += 1;
      }
      return { added, skipped };
    });
    res.status(201).json({ success: true, ...result });
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
    // Mật khẩu tạm được sinh ngẫu nhiên, chỉ lưu bản băm trong cơ sở dữ liệu.
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
  router.get('/users/candidate-template', route(async (_req, res) => {
    // Mẫu không có cột vai trò hoặc mật khẩu vì API này luôn chỉ cấp tài khoản thí sinh.
    const workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Tai khoan thi sinh', [
      { header: 'Họ tên', key: 'hoten', width: 30 }, { header: 'Số điện thoại', key: 'dienthoai', width: 20 },
      { header: 'Email', key: 'email', width: 32 }, { header: 'Đơn vị', key: 'unitName', width: 36 }
    ]);
    sheet.addRow({ hoten: 'Nguyễn Văn A', dienthoai: '0901234567', email: 'nguyenvana@example.com', unitName: 'Đoàn xã Minh Khai' });
    await sendWorkbook(res, workbook, 'mau-cap-tai-khoan-thi-sinh.xlsx');
  }));
  router.post('/users/import-candidates', upload.single('file'), route(async (req, res) => {
    const rows = await readCandidateAccountWorkbook(req.file);
    const result = await pool.transaction(async tx => {
      const [unitRows] = await tx.query('SELECT id,ten FROM donvi');
      const units = new Map();
      for (const item of unitRows) {
        const key = item.ten.trim().toLocaleLowerCase('vi');
        // Không tự chọn khi database cũ có nhiều đơn vị cùng tên thuộc các đoàn cơ sở khác nhau.
        units.set(key, units.has(key) ? null : item.id);
      }
      const prepared = rows.map(row => {
        const hoten = textField(row.hoten, `Họ tên dòng ${row.row}`);
        const dienthoai = textField(row.dienthoai, `Số điện thoại dòng ${row.row}`, 30).replace(/[\s.-]/g, '');
        const email = textField(row.email, `Email dòng ${row.row}`, 254).toLowerCase();
        const unitId = units.get(row.unitName.trim().toLocaleLowerCase('vi'));
        if (!/^\+?\d{9,15}$/.test(dienthoai) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, `Dòng ${row.row}: số điện thoại hoặc email không hợp lệ.`);
        // Đơn vị chưa có sẽ được thống kê để bỏ qua dòng này, không làm dừng toàn bộ lần nhập.
        return { hoten, dienthoai, email, unitId, row: row.row };
      });
      const emails = [...new Set(prepared.map(item => item.email))], phones = [...new Set(prepared.map(item => item.dienthoai))];
      const [existingRows] = await tx.query(`SELECT email,dienthoai FROM users WHERE email IN (${emails.map(() => '?').join(',')}) OR dienthoai IN (${phones.map(() => '?').join(',')})`, [...emails, ...phones]);
      const existingEmails = new Set(existingRows.map(item => item.email)), existingPhones = new Set(existingRows.map(item => item.dienthoai));
      const importedEmails = new Set(), importedPhones = new Set();
      let added = 0, skippedDuplicates = 0, skippedMissingUnits = 0;
      for (const item of prepared) {
        if (!item.unitId) { skippedMissingUnits += 1; continue; }
        if (existingEmails.has(item.email) || existingPhones.has(item.dienthoai) || importedEmails.has(item.email) || importedPhones.has(item.dienthoai)) { skippedDuplicates += 1; continue; }
        // Mật khẩu tạm có đúng 8 ký tự: bốn ký tự đầu email và bốn số cuối điện thoại.
        const temporaryPassword = `${item.email.slice(0, 4)}${item.dienthoai.slice(-4)}`;
        const hash = await bcrypt.hash(temporaryPassword, 12);
        const [created] = await tx.query("INSERT INTO users (hoten,dienthoai,email,donviID,password,is_active,role,permissions,must_change_password) VALUES (?,?,?,?,?,1,'candidate','[]',1)", [item.hoten, item.dienthoai, item.email, item.unitId, hash]);
        await audit(tx, req.user.id, 'user.candidate.import', 'user', created.insertId);
        importedEmails.add(item.email); importedPhones.add(item.dienthoai); added += 1;
      }
      return { added, skippedDuplicates, skippedMissingUnits };
    });
    res.status(201).json({ success: true, ...result });
  }));
  router.put('/users/:id/access', route(async (req, res) => {
    // Cập nhật quyền sẽ tăng token_version để buộc các phiên đăng nhập cũ đăng nhập lại.
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
    // Sau khi cấp mật khẩu tạm, người dùng bắt buộc đổi mật khẩu ở lần đăng nhập tiếp theo.
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
