import { Router } from 'express';
import ExcelJS from 'exceljs';
import { createAccess } from '../auth/access.js';
import { dateFilters, fail, positiveId, requirePermission, route } from '../common/http.js';
import { sendWorkbook, styledSheet } from '../site/files.js';

// Tổng hợp theo kết quả tốt nhất của mỗi thí sinh; số lượt thi vẫn đếm toàn bộ phiên đã mở.
function statistics(sessions) {
  const candidates = new Set(), scores = new Map();
  for (const item of sessions) {
    candidates.add(String(item.userId));
    if (item.score !== null && item.score !== undefined) {
      const key = String(item.userId), score = Number(item.score);
      scores.set(key, Math.max(scores.get(key) ?? -Infinity, score));
    }
  }
  const values = [...scores.values()], passingScore = Number(sessions[0]?.passingScore || 0);
  const passed = values.filter(score => score >= passingScore).length;
  return { participants: candidates.size, attempts: sessions.length, passed, failed: values.length - passed, averageScore: values.length ? Math.round(values.reduce((sum, score) => sum + score, 0) / values.length * 100) / 100 : null };
}

// Đưa tiêu chí có giá trị lên đầu trang tính và giữ dòng tiêu đề bảng ngay sau đó.
function prependCriteria(sheet, criteria) {
  const filled = criteria.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (!filled.length) return;
  sheet.spliceRows(1, 0, ...filled.map(([label, value]) => [label, value]));
  const header = sheet.getRow(filled.length + 1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF174C87' } };
  sheet.views = [{ state: 'frozen', ySplit: filled.length + 1 }];
}

// Đổi mã bộ lọc thành tên hiển thị để phần đầu file Excel dễ đọc.
async function readableCriteria(pool, query, { includeLookup = false } = {}) {
  const criteria = [];
  if (query.competitionId) {
    const [[competition]] = await pool.query('SELECT name FROM competitions WHERE id=?', [query.competitionId]);
    if (competition) criteria.push(['Kỳ thi', competition.name]);
  }
  if (query.roundId) {
    const [[round]] = await pool.query('SELECT name,round_number AS roundNumber FROM rounds WHERE id=?', [query.roundId]);
    if (round) criteria.push(['Vòng thi', round.name || `Vòng ${round.roundNumber}`]);
  } else criteria.push(['Vòng thi', 'Tất cả vòng thi']);
  if (query.organizationId) {
    const [[organization]] = await pool.query('SELECT ten FROM doancoso WHERE id=?', [query.organizationId]);
    if (organization) criteria.push(['Đoàn cơ sở', organization.ten]);
  } else criteria.push(['Đoàn cơ sở', 'Tất cả đoàn cơ sở']);
  if (includeLookup) {
    if (String(query.q || '').trim()) criteria.push(['Họ và tên', String(query.q).trim()]);
    criteria.push(['Trạng thái', query.status === 'passed' ? 'Đạt' : query.status === 'failed' ? 'Không đạt' : 'Tất cả trạng thái']);
  }
  if (query.from) criteria.push(['Từ ngày', query.from]);
  if (query.to) criteria.push(['Đến ngày', query.to]);
  return criteria;
}

async function buildHierarchy(pool, user, competitionId, roundId, organizationId, dates) {
  // Trả danh mục đoàn cơ sở ngay cả khi chưa chọn kỳ thi để bộ lọc luôn có dữ liệu.
  const [organizations] = await pool.query('SELECT id,ten AS name FROM doancoso ORDER BY ten');
  const where = [], values = [];
  if (competitionId) { where.push('s.competition_id=?'); values.push(competitionId); }
  if (roundId) { where.push('s.round_id=?'); values.push(roundId); }
  if (organizationId) { where.push('d.doanCoSoID=?'); values.push(organizationId); }
  if (user.role === 'teacher') { where.push('EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id=s.competition_id AND tc.user_id=?)'); values.push(user.id); }
  if (dates.from) { where.push('s.started_at>=?'); values.push(`${dates.from} 00:00:00`); }
  if (dates.to) { where.push('s.started_at<DATE_ADD(?,INTERVAL 1 DAY)'); values.push(`${dates.to} 00:00:00`); }
  const [sessions] = await pool.query(`SELECT s.user_id AS userId,s.competition_id AS competitionId,c.name AS competitionName,s.round_id AS roundId,s.score,c.passing_score AS passingScore,
    rd.round_number AS roundNumber,rd.name AS roundName,d.id AS unitId,d.ten AS unitName
    FROM user_exam_sessions s JOIN competitions c ON c.id=s.competition_id
    LEFT JOIN rounds rd ON rd.id=s.round_id LEFT JOIN donvi d ON d.id=(SELECT cr.unit_id FROM competition_registrations cr WHERE cr.user_id=s.user_id AND cr.competition_id=s.competition_id LIMIT 1)
    WHERE ${where.length ? where.join(' AND ') : '1=1'}`, values);
  // Khi không chọn kỳ thi, vẫn giữ đủ cấu trúc: tổng chung, từng kỳ thi, vòng và đơn vị.
  if (!competitionId) {
    const competitionItems = [...new Map(sessions.map(item => [String(item.competitionId), { id: item.competitionId, name: item.competitionName }])).values()];
    if (!competitionItems.length) return { rows: [{ type: 'total', label: 'Tổng cộng: Tất cả kỳ thi', ...statistics(sessions) }], organizations, rounds: [] };
    const placeholders = competitionItems.map(() => '?').join(',');
    const [allRounds] = await pool.query(`SELECT id,competition_id AS competitionId,round_number AS roundNumber,name FROM rounds WHERE enabled=1 AND competition_id IN (${placeholders}) ORDER BY competition_id,round_number,id`, competitionItems.map(item => item.id));
    const rows = [{ type: 'total', label: 'Tổng cộng: Tất cả kỳ thi', ...statistics(sessions) }];
    for (const competition of competitionItems) {
      const competitionSessions = sessions.filter(item => Number(item.competitionId) === Number(competition.id));
      rows.push({ type: 'competition', label: competition.name, ...statistics(competitionSessions) });
      for (const round of allRounds.filter(item => Number(item.competitionId) === Number(competition.id))) {
        const roundSessions = competitionSessions.filter(item => Number(item.roundId) === Number(round.id));
        rows.push({ type: 'round', label: round.name || `Vòng ${round.roundNumber}`, ...statistics(roundSessions) });
        const units = new Map();
        for (const item of roundSessions) { const key = item.unitId ?? 'none'; if (!units.has(key)) units.set(key, []); units.get(key).push(item); }
        for (const [unitId, unitSessions] of units) rows.push({ type: 'unit', label: unitSessions[0].unitName || 'Chưa chọn đơn vị', unitId, ...statistics(unitSessions) });
      }
    }
    return { rows, organizations, rounds: [] };
  }
  const [[competition]] = await pool.query('SELECT id,name FROM competitions WHERE id=?', [competitionId]);
  const [allRounds] = await pool.query('SELECT id,round_number AS roundNumber,name FROM rounds WHERE competition_id=? AND enabled=1 ORDER BY round_number,id', [competitionId]);
  if (roundId && !allRounds.some(round => Number(round.id) === Number(roundId))) throw fail(400, 'Vòng thi không thuộc kỳ thi đã chọn.');
  const rounds = roundId ? allRounds.filter(round => Number(round.id) === Number(roundId)) : allRounds;
  if (!competition) return { rows: [], organizations };
  const rows = [{ type: 'total', label: `Tổng cộng: ${competition.name}`, ...statistics(sessions) }];
  for (const round of rounds) {
    const roundSessions = sessions.filter(item => Number(item.roundId) === Number(round.id));
    rows.push({ type: 'round', label: round.name || `Vòng ${round.roundNumber}`, ...statistics(roundSessions) });
    const units = new Map();
    for (const item of roundSessions) { const key = item.unitId ?? 'none'; if (!units.has(key)) units.set(key, []); units.get(key).push(item); }
    for (const [unitId, unitSessions] of [...units.entries()].sort((a, b) => String(a[1][0].unitName || '').localeCompare(String(b[1][0].unitName || ''), 'vi'))) rows.push({ type: 'unit', label: unitSessions[0].unitName || 'Chưa chọn đơn vị', unitId, ...statistics(unitSessions) });
  }
  return { rows, organizations, rounds: allRounds };
}

// Tạo báo cáo từ lượt đăng ký thực tế và phiên làm bài đã lưu.
// registrations: số bản ghi đăng ký kỳ thi thực tế, không suy ra từ tài khoản hay dữ liệu cũ.
// attempts: số phiên đã bắt đầu; completed: số phiên đã kết thúc và có điểm để tính averageScore.
// Kết quả cũ thiếu phiên không được tự biến thành một lượt thi vì không biết thời điểm bắt đầu.
export async function buildReport(pool, user, query) {
  const dates = dateFilters(query), competitionId = query.competitionId ? positiveId(query.competitionId) : null;
  const organizationId = query.organizationId ? positiveId(query.organizationId, 'Đoàn cơ sở') : null;
  const roundId = query.roundId ? positiveId(query.roundId, 'Vòng thi') : null;
  if (user.role === 'teacher') requirePermission(user, 'reports');
  function conditions(competitionColumn, dateColumn, userColumn) {
    const values = [], where = [];
    if (competitionId) { where.push(`${competitionColumn}=?`); values.push(competitionId); }
    if (user.role === 'teacher') { where.push(`EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id=${competitionColumn} AND tc.user_id=?)`); values.push(user.id); }
    if (user.role === 'candidate') {
      // Thí sinh chỉ được xem số đăng ký, lượt thi và điểm của chính tài khoản mình.
      where.push(`${userColumn}=?`, "c.status IN ('published','closed')");
      values.push(user.id);
    }
    if (dates.from) { where.push(`${dateColumn}>=?`); values.push(`${dates.from} 00:00:00`); }
    if (dates.to) { where.push(`${dateColumn}<DATE_ADD(?,INTERVAL 1 DAY)`); values.push(`${dates.to} 00:00:00`); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
  }
  const resolvedCompetition = 'COALESCE(s.competition_id,rd.competition_id,e.competition_id)';
  // Giữ đơn vị đã chụp lúc đăng ký, kể cả NULL. Chỉ dùng hồ sơ hiện tại khi phiên cũ chưa có đăng ký kỳ thi.
  const resolvedUnit = 'CASE WHEN r.user_id IS NULL THEN u.donviID ELSE r.unit_id END';
  const registrationFilter = conditions('r.competition_id', 'r.registered_at', 'r.user_id');
  const attemptFilter = conditions(resolvedCompetition, 's.started_at', 's.user_id');
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
  const hierarchy = user.role === 'candidate' ? { rows: [], organizations: [], rounds: [] } : await buildHierarchy(pool, user, competitionId, roundId, organizationId, dates);
  return { summary: output(total), units: [...units.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')).map(output), rows: hierarchy.rows, organizations: hierarchy.organizations, rounds: hierarchy.rounds, filters: { competitionId, roundId, organizationId, ...dates } };
}

// Tra cứu lấy một bài tốt nhất của mỗi thí sinh trong phạm vi lọc để tránh lặp lại người thi nhiều lần.
async function lookupResults(pool, user, query) {
  const competitionId = positiveId(query.competitionId, 'Kỳ thi');
  const roundId = query.roundId ? positiveId(query.roundId, 'Vòng thi') : null;
  const organizationId = query.organizationId ? positiveId(query.organizationId, 'Đoàn cơ sở') : null;
  const status = query.status || 'all';
  if (!['all', 'passed', 'failed'].includes(status)) throw fail(400, 'Trạng thái tra cứu không hợp lệ.');
  const keyword = String(query.q || '').trim().slice(0, 255);
  const where = ['s.competition_id=?', 's.finished_at IS NOT NULL', 's.score IS NOT NULL'], values = [competitionId];
  if (roundId) { where.push('s.round_id=?'); values.push(roundId); }
  if (organizationId) { where.push('d.doanCoSoID=?'); values.push(organizationId); }
  if (keyword) { where.push('u.hoten LIKE ?'); values.push(`%${keyword}%`); }
  if (user.role === 'teacher') { requirePermission(user, 'reports'); where.push('EXISTS (SELECT 1 FROM teacher_competitions tc WHERE tc.competition_id=s.competition_id AND tc.user_id=?)'); values.push(user.id); }
  if (user.role === 'candidate') { where.push('s.user_id=?'); values.push(user.id); }
  const [rows] = await pool.query(`SELECT s.id,s.user_id AS userId,u.hoten,d.ten AS unitName,s.finished_at AS finishedAt,s.score,c.passing_score AS passingScore,
    TIMESTAMPDIFF(SECOND,s.started_at,s.finished_at) AS durationSeconds
    FROM user_exam_sessions s JOIN users u ON u.id=s.user_id JOIN competitions c ON c.id=s.competition_id
    LEFT JOIN competition_registrations cr ON cr.user_id=s.user_id AND cr.competition_id=s.competition_id
    LEFT JOIN donvi d ON d.id=cr.unit_id WHERE ${where.join(' AND ')}`, values);
  const ordered = [...rows].sort((a, b) => Number(b.score) - Number(a.score) || Number(a.durationSeconds) - Number(b.durationSeconds) || new Date(a.finishedAt) - new Date(b.finishedAt) || Number(a.id) - Number(b.id));
  const best = [...new Map(ordered.map(item => [String(item.userId), item])).values()].filter(item => status === 'all' || (status === 'passed' ? Number(item.score) >= Number(item.passingScore) : Number(item.score) < Number(item.passingScore)));
  return best.sort((a, b) => a.hoten.localeCompare(b.hoten, 'vi') || Number(a.id) - Number(b.id)).map(item => ({ id: item.id, fullName: item.hoten, unitName: item.unitName || 'Chưa chọn đơn vị', finishedAt: item.finishedAt, score: Number(item.score), status: Number(item.score) >= Number(item.passingScore) ? 'passed' : 'failed' }));
}

export function createReportsRouter({ pool }) {
  // Xuất Excel dùng đúng cùng bộ lọc và số liệu với API hiển thị trên giao diện.
  const router = Router();
  router.use(createAccess({ pool }));
  router.get('/', route(async (req, res) => res.json({ success: true, ...await buildReport(pool, req.user, req.query) })));
  router.get('/results', route(async (req, res) => res.json({ success: true, items: await lookupResults(pool, req.user, req.query) })));
  router.get('/results/export', route(async (req, res) => {
    requirePermission(req.user, 'reports');
    const items = await lookupResults(pool, req.user, req.query), workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Tra cuu ket qua', [
      { header: 'STT', key: 'sequence', width: 10 }, { header: 'Họ và tên', key: 'fullName', width: 32 },
      { header: 'Đơn vị thi', key: 'unitName', width: 36 }, { header: 'Thời gian nộp bài', key: 'finishedAt', width: 24 },
      { header: 'Trạng thái', key: 'statusLabel', width: 16 }, { header: 'Điểm thi', key: 'score', width: 14 }
    ]);
    prependCriteria(sheet, await readableCriteria(pool, req.query, { includeLookup: true }));
    // Chỉ xuất dữ liệu backend đã lọc; không đưa nội dung người dùng vào công thức Excel.
    sheet.addRows(items.map((item, index) => ({ ...item, sequence: index + 1, statusLabel: item.status === 'passed' ? 'Đạt' : 'Không đạt' })));
    await sendWorkbook(res, workbook, 'tra-cuu-ket-qua.xlsx');
  }));
  router.get('/export', route(async (req, res) => {
    requirePermission(req.user, 'reports');
    const report = await buildReport(pool, req.user, req.query), workbook = new ExcelJS.Workbook();
    const sheet = styledSheet(workbook, 'Thong ke', [
      { header: 'STT', key: 'sequence', width: 10 }, { header: 'Đơn vị / vòng thi', key: 'label', width: 48 },
      { header: 'Số thí sinh tham gia', key: 'participants', width: 22 }, { header: 'Số lượt thi', key: 'attempts', width: 16 },
      { header: 'Đạt', key: 'passed', width: 12 }, { header: 'Không đạt', key: 'failed', width: 14 }, { header: 'Điểm trung bình / 100', key: 'averageScore', width: 24 }
    ]);
    prependCriteria(sheet, await readableCriteria(pool, report.filters));
    // Đánh số giống giao diện: tổng cộng để trống, vòng là 1/2..., đơn vị là 1.1/1.2....
    let roundNumber = 0, unitNumber = 0;
    const rows = report.rows.map(item => {
      if (item.type === 'total' || item.type === 'competition') return { ...item, sequence: '' };
      if (item.type === 'round') { roundNumber += 1; unitNumber = 0; return { ...item, sequence: String(roundNumber) }; }
      unitNumber += 1;
      return { ...item, sequence: `${roundNumber}.${unitNumber}` };
    });
    // Chuỗi được ghi dưới dạng văn bản, không chuyển nội dung người dùng thành công thức Excel.
    rows.forEach(item => { const row = sheet.addRow(item); if (item.type !== 'unit') row.font = { bold: true }; });
    await sendWorkbook(res, workbook, 'bao-cao-thong-ke.xlsx');
  }));
  return router;
}
