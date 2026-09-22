import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { requireRoles } from '../auth/access.js';
import { audit, fail, integer, parseJson, positiveId, route, textField } from '../common/http.js';
import { CANDIDATE_ACCOUNT_HEADERS, readCandidateAccountWorkbook, readUnitWorkbook, sendWorkbook, styledSheet, upload } from '../site/files.js';

const DEFAULT_UNIT_ORGANIZATION = 'T\u1ec9nh \u0111o\u00e0n V\u0129nh Long';
// Mật khẩu khởi tạo theo quy ước của đơn vị: bốn ký tự đầu email và bốn số cuối điện thoại.
const candidateInitialPassword = (email, phone) => `${String(email).trim().slice(0, 4)}${String(phone).replace(/\D/g, '').slice(-4)}`;

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
  // Ch? gi? m?t t?c v? nh?p t?i kho?n trong b? nh? ?? tr?nh nhi?u l? bcrypt c?ng chi?m CPU.
  let candidateImportJob = null;
  const yieldToRequests = () => new Promise(resolve => setImmediate(resolve));

  async function processCandidateImport(job) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const [unitRows] = await pool.query('SELECT id,ten FROM donvi');
      const unitByName = new Map(unitRows.map(item => [String(item.ten).trim().toLocaleLowerCase('vi'), item]));
      const [existingRows] = await pool.query('SELECT dienthoai,email FROM users');
      const usedPhones = new Set(existingRows.map(item => String(item.dienthoai || '')));
      const usedEmails = new Set(existingRows.map(item => String(item.email || '').trim().toLocaleLowerCase('vi')));
      const importedPhones = new Set(), importedEmails = new Set();
      const batchSize = 10;
      for (let offset = 0; offset < job.rows.length; offset += batchSize) {
        const batch = job.rows.slice(offset, offset + batchSize);
        for (const row of batch) {
          const phone = String(row.dienthoai || '').replace(/[\s.-]/g, '');
          const email = String(row.email || '').trim().toLocaleLowerCase('vi');
          const errors = [];
          if (!row.hoten || row.hoten.length > 255) errors.push('Họ và tên không hợp lệ');
          if (!/^\+?\d{9,15}$/.test(phone)) errors.push('Số điện thoại không hợp lệ');
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('Email không hợp lệ');
          if (usedPhones.has(phone) || importedPhones.has(phone)) errors.push('Số điện thoại đã được đăng ký');
          if (usedEmails.has(email) || importedEmails.has(email)) errors.push('Email đã được đăng ký');
          const unit = unitByName.get(String(row.unitName || '').trim().toLocaleLowerCase('vi'));
          if (!unit) errors.push('Đơn vị chưa có trong hệ thống');
          const chucVu = row.chucVu?.trim() || 'Đoàn viên';
          if (chucVu.length > 100) errors.push('Chức vụ không quá 100 ký tự');
          if (errors.length) job.skipped.push({ row: row.row, errors });
          else {
            const password = candidateInitialPassword(email, phone);
            // Mã hóa ngoài transaction để không giữ khóa database trong thời gian bcrypt chạy.
            const hash = await bcrypt.hash(password, 12);
            try {
              await pool.transaction(async tx => {
                const [created] = await tx.query("INSERT INTO users (hoten,dienthoai,email,chuc_vu,donviID,password,is_active,role,permissions,must_change_password) VALUES (?,?,?,?,?,?,1,'candidate','[]',1)", [row.hoten.trim(), phone, email, chucVu, unit.id, hash]);
                await audit(tx, job.actorId, 'candidate.bulk_import', 'user', created.insertId);
              });
              usedPhones.add(phone); usedEmails.add(email); importedPhones.add(phone); importedEmails.add(email);
              job.credentials.push({ hoten: row.hoten.trim(), chucVu, unitName: unit.ten, dienthoai: phone, email, password });
              job.added += 1;
            } catch (error) {
              if (error?.code === 'ER_DUP_ENTRY') job.skipped.push({ row: row.row, errors: ['Số điện thoại hoặc email đã được đăng ký'] });
              else throw error;
            }
          }
          job.processed += 1;
          job.updatedAt = new Date().toISOString();
        }
        // Nhường event loop sau mỗi lô để các API thi và đăng nhập vẫn được phục vụ.
        await yieldToRequests();
      }
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = 'Không thể hoàn tất nhập tài khoản. Vui lòng kiểm tra log máy chủ.';
      console.error('Candidate bulk import:', error.code || error.name);
    } finally {
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
    }
  }


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
  router.get('/users/candidates/template', route(async (_req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Tai khoan thi sinh', CANDIDATE_ACCOUNT_HEADERS.map((header, index) => ({ header, key: ['sequence', 'hoten', 'chucVu', 'unitName', 'dienthoai', 'email'][index], width: index === 1 ? 32 : 24 })));
    sheet.addRow({ sequence: 1, hoten: 'Nguyễn Văn A', chucVu: 'Đoàn viên', unitName: 'Đoàn xã Minh Khai', dienthoai: '0900000001', email: 'nguyenvana@example.com' });
    await sendWorkbook(res, workbook, 'mau-tai-khoan-thi-sinh.xlsx');
  }));
  router.post('/users/candidates/import', upload.single('file'), route(async (req, res) => {
    if (candidateImportJob && ['pending', 'running'].includes(candidateImportJob.status)) throw fail(409, '?ang c? m?t t?c v? nh?p t?i kho?n th? sinh. Vui l?ng ch? t?c v? n?y ho?n t?t.', 'IMPORT_IN_PROGRESS');
    const rows = await readCandidateAccountWorkbook(req.file);
    candidateImportJob = { id: randomBytes(12).toString('hex'), actorId: req.user.id, rows, total: rows.length, processed: 0, added: 0, skipped: [], credentials: [], status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null };
    const job = candidateImportJob;
    setImmediate(() => { processCandidateImport(job); });
    res.status(202).json({ success: true, job: { id: job.id, status: job.status, total: job.total, processed: job.processed, added: job.added, skipped: job.skipped } });
  }));
  router.get('/users/candidates/import/status', route(async (req, res) => {
    if (!candidateImportJob) return res.json({ success: true, job: null });
    const job = candidateImportJob;
    res.json({ success: true, job: { id: job.id, status: job.status, total: job.total, processed: job.processed, added: job.added, skipped: job.skipped, credentials: job.status === 'completed' ? job.credentials : [], error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt || null } });
  }));
  router.get('/users/candidates/export', route(async (_req, res) => {
    // Chỉ xuất tài khoản được tạo từ tệp Excel, không lẫn tài khoản tự đăng ký hoặc cấp thủ công.
    const [items] = await pool.query("SELECT u.hoten,u.chuc_vu AS chucVu,d.ten AS unitName,u.dienthoai,u.email FROM users u LEFT JOIN donvi d ON d.id=u.donviID WHERE u.role='candidate' AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.target_type='user' AND a.target_id=CAST(u.id AS CHAR) AND a.action='candidate.bulk_import') ORDER BY u.hoten,u.id");
    const workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Danh sach thi sinh', [
      ...CANDIDATE_ACCOUNT_HEADERS.map((header, index) => ({ header, key: ['sequence', 'hoten', 'chucVu', 'unitName', 'dienthoai', 'email'][index], width: index === 1 ? 32 : 24 })),
      { header: 'Mật khẩu', key: 'password', width: 28 }
    ]);
    // File thể hiện mật khẩu khởi tạo theo quy ước; người dùng có thể đã đổi mật khẩu sau lần đăng nhập đầu tiên.
    sheet.addRows(items.map((item, index) => ({ ...item, sequence: index + 1, chucVu: item.chucVu || 'Đoàn viên', password: candidateInitialPassword(item.email, item.dienthoai) })));
    await sendWorkbook(res, workbook, 'danh-sach-tai-khoan-thi-sinh-nhap-excel.xlsx');
  }));
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
      { header: 'STT', key: 'sequence', width: 10 }, { header: '\u0110\u01a1n v\u1ecb', key: 'ten', width: 52 }
    ]);
    sheet.addRows([
      { sequence: 1, ten: 'Đoàn xã Minh Khai' },
      { sequence: 2, ten: 'Đoàn trường THPT Minh Khai' }
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
        const organization = DEFAULT_UNIT_ORGANIZATION;
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
    const page = integer(req.query.page || 1, 'Trang', 1, 1000000), pageSize = integer(req.query.pageSize || 10, 'Số dòng', 1, 500);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users u ${where}`, values);
    const [rows] = await pool.query(`SELECT u.id,u.hoten,u.dienthoai,u.email,u.chuc_vu AS chucVu,u.donviID,u.role,u.permissions,u.is_active,u.must_change_password FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    const ids = rows.map(row => row.id);
    const [assignments] = ids.length ? await pool.query(`SELECT user_id,competition_id FROM teacher_competitions WHERE user_id IN (${ids.map(() => '?').join(',')})`, ids) : [[]];
    const items = rows.map(row => ({ ...row, is_active: Number(row.is_active) === 1, must_change_password: Number(row.must_change_password) === 1, permissions: parseJson(row.permissions, []), competitionIds: assignments.filter(a => Number(a.user_id) === Number(row.id)).map(a => Number(a.competition_id)) }));
    res.json({ success: true, items, total: Number(total), page, pageSize });
  }));
  router.post('/users', route(async (req, res) => {
    const access = accessInput(req.body, true), name = textField(req.body.hoten, 'Họ tên');
    const chucVu = textField(req.body.chucVu || 'Đoàn viên', 'Chức vụ', 100);
    const phone = textField(req.body.dienthoai, 'Số điện thoại', 30).replace(/[\s.-]/g, '');
    const email = textField(req.body.email, 'Email', 254).toLowerCase();
    if (!/^\+?\d{9,15}$/.test(phone) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Số điện thoại hoặc email không hợp lệ.');
    const unit = req.body.donviID ? positiveId(req.body.donviID, 'Đơn vị') : null;
    if (access.role === 'candidate' && !unit) throw fail(400, 'Tài khoản thí sinh cần chọn đơn vị.');
    // Mật khẩu tạm được sinh ngẫu nhiên, chỉ lưu bản băm trong cơ sở dữ liệu.
    const temporaryPassword = randomBytes(18).toString('base64url'), hash = await bcrypt.hash(temporaryPassword, 12);
    const id = await pool.transaction(async tx => {
      if (unit) { const [[exists]] = await tx.query('SELECT id FROM donvi WHERE id=?', [unit]); if (!exists) throw fail(400, 'Đơn vị không tồn tại.'); }
      const [result] = await tx.query('INSERT INTO users (hoten,dienthoai,email,chuc_vu,donviID,password,is_active,role,permissions,must_change_password) VALUES (?,?,?,?,?, ?,1,?,?,1)', [name, phone, email, chucVu, unit, hash, access.role, JSON.stringify(access.permissions)]);
      await assignCompetitions(tx, result.insertId, access.competitionIds);
      await audit(tx, req.user.id, 'user.create', 'user', result.insertId);
      return result.insertId;
    });
    // Mật khẩu tạm chỉ xuất hiện trong phản hồi này, không lưu rõ hay ghi nhật ký.
    res.status(201).json({ success: true, item: { id, hoten: name, dienthoai: phone, email, chucVu, role: access.role }, temporaryPassword });
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
    if (id === Number(req.user.id)) throw fail(409, 'Bạn không thể tự đặt lại mật khẩu tại đây. Hãy đổi mật khẩu trong phần Thông tin tài khoản.');
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
