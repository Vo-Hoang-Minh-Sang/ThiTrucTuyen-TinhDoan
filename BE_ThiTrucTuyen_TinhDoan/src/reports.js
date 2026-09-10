import { Router } from 'express';
import ExcelJS from 'exceljs';
import { createAccess } from './access.js';
import { dateFilters, positiveId, requirePermission, route } from './http.js';
import { sendWorkbook, styledSheet } from './files.js';

// registrations: số bản ghi đăng ký kỳ thi thực tế, không suy ra từ tài khoản hay dữ liệu cũ.
// attempts: số phiên đã bắt đầu; completed: số phiên đã kết thúc và có điểm để tính averageScore.
// Kết quả cũ thiếu phiên không được tự biến thành một lượt thi vì không biết thời điểm bắt đầu.
export async function buildReport(pool, user, query) {
  const dates = dateFilters(query), competitionId = query.competitionId ? positiveId(query.competitionId) : null;
  if (user.role === 'teacher') requirePermission(user, 'reports');
  function conditions(competitionColumn, dateColumn) {
    const values = [], where = [];
    if (competitionId) { where.push(`${competitionColumn}=?`); values.push(competitionId); }
    if (user.role === 'teacher') { where.push(`EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id=${competitionColumn} AND tc.user_id=?)`); values.push(user.id); }
    if (user.role === 'candidate') where.push("c.status IN ('published','closed')");
    if (dates.from) { where.push(`${dateColumn}>=?`); values.push(`${dates.from} 00:00:00`); }
    if (dates.to) { where.push(`${dateColumn}<DATE_ADD(?,INTERVAL 1 DAY)`); values.push(`${dates.to} 00:00:00`); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
  }
  const resolvedCompetition = 'COALESCE(s.competition_id,rd.competition_id,e.competition_id)';
  // Giữ đơn vị đã chụp lúc đăng ký, kể cả NULL. Chỉ dùng hồ sơ hiện tại khi phiên cũ chưa có đăng ký kỳ thi.
  const resolvedUnit = 'CASE WHEN r.user_id IS NULL THEN u.donviID ELSE r.unit_id END';
  const registrationFilter = conditions('r.competition_id', 'r.registered_at'), attemptFilter = conditions(resolvedCompetition, 's.started_at');
  const [[registrations], [attempts]] = await Promise.all([
    pool.query(`SELECT r.unit_id AS unitId,d.ten AS name,COUNT(*) AS registrations FROM competition_registrations r JOIN competitions c ON c.id=r.competition_id LEFT JOIN donvi d ON d.id=r.unit_id ${registrationFilter.sql} GROUP BY r.unit_id,d.ten`, registrationFilter.values),
    pool.query(`SELECT ${resolvedUnit} AS unitId,d.ten AS name,COUNT(*) AS attempts,
      SUM(s.finished_at IS NOT NULL AND s.score IS NOT NULL) AS completed,
      COALESCE(SUM(CASE WHEN s.finished_at IS NOT NULL THEN s.score ELSE 0 END),0) AS scoreTotal
      FROM user_exam_sessions s JOIN exams e ON e.id=s.exam_id
      LEFT JOIN rounds rd ON rd.id=COALESCE(s.round_id,e.round_id)
      JOIN competitions c ON c.id=${resolvedCompetition} JOIN users u ON u.id=s.user_id
      LEFT JOIN competition_registrations r ON r.user_id=s.user_id AND r.competition_id=c.id
      LEFT JOIN donvi d ON d.id=(${resolvedUnit})
      ${attemptFilter.sql} GROUP BY ${resolvedUnit},d.ten`, attemptFilter.values)
  ]);
  const units = new Map();
  const entry = row => {
    const id = row.unitId == null ? null : Number(row.unitId);
    if (!units.has(id)) units.set(id, { id, name: row.name || 'Chưa có đơn vị', registrations: 0, attempts: 0, completed: 0, scoreTotal: 0 });
    return units.get(id);
  };
  registrations.forEach(row => { entry(row).registrations = Number(row.registrations); });
  attempts.forEach(row => Object.assign(entry(row), { attempts: Number(row.attempts), completed: Number(row.completed), scoreTotal: Number(row.scoreTotal) }));
  const total = { registrations: 0, attempts: 0, completed: 0, scoreTotal: 0 };
  for (const unit of units.values()) for (const key of Object.keys(total)) total[key] += unit[key];
  const output = value => { const { scoreTotal, ...item } = value; return { ...item, averageScore: value.completed ? Math.round(scoreTotal / value.completed * 100) / 100 : null }; };
  return { summary: output(total), units: [...units.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')).map(output), filters: { competitionId, ...dates } };
}

export function createReportsRouter({ pool }) {
  const router = Router();
  router.use(createAccess({ pool }));
  router.get('/', route(async (req, res) => res.json({ success: true, ...await buildReport(pool, req.user, req.query) })));
  router.get('/export', route(async (req, res) => {
    requirePermission(req.user, 'reports');
    const report = await buildReport(pool, req.user, req.query), workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Thong ke', [
      { header: 'Đơn vị', key: 'name', width: 48 }, { header: 'Lượt đăng ký kỳ thi', key: 'registrations' },
      { header: 'Lượt bắt đầu thi', key: 'attempts' }, { header: 'Bài đã chấm', key: 'completed' }, { header: 'Điểm trung bình / 100', key: 'averageScore' }
    ]);
    // Chuỗi được ghi dưới dạng văn bản, không chuyển nội dung người dùng thành công thức Excel.
    sheet.addRows(report.units);
    sheet.addRow({ name: 'Tổng cộng', ...report.summary }).font = { bold: true };
    const filterSheet = styledSheet(workbook, 'Pham vi', [{ header: 'Điều kiện', key: 'key', width: 32 }, { header: 'Giá trị', key: 'value', width: 64 }]);
    filterSheet.addRows([
      { key: 'Mã kỳ thi', value: report.filters.competitionId || 'Tất cả kỳ thi trong phạm vi được phép' },
      { key: 'Từ ngày', value: report.filters.from || 'Không giới hạn' }, { key: 'Đến ngày', value: report.filters.to || 'Không giới hạn' },
      { key: 'Cách tính', value: 'Đăng ký theo ngày đăng ký kỳ thi; lượt thi và điểm theo ngày bắt đầu bài.' },
      { key: 'Phiên cũ', value: 'Kỳ thi được lấy từ phiên, vòng thi hoặc đề. Nếu chưa có đăng ký kỳ thi, đơn vị lấy từ hồ sơ hiện tại.' },
      { key: 'Giới hạn dữ liệu cũ', value: 'Không suy ra đăng ký từ phiên cũ; không suy ra lượt thi từ kết quả thiếu phiên.' },
      { key: 'Điểm trung bình', value: 'Chỉ tính phiên đã kết thúc và có điểm; dữ liệu thiếu điểm không được tính là 0.' },
      { key: 'Xuất lúc', value: new Date().toISOString() }
    ]);
    await sendWorkbook(res, workbook, 'bao-cao-thong-ke.xlsx');
  }));
  return router;
}

