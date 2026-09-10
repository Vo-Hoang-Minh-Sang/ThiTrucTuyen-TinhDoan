import { Router } from 'express';

// Chuẩn hóa kiểu ngày MySQL trả về; ngày kết thúc không có giờ được tính đến hết ngày đó.
const asDate = (value, endOfDay = false) => {
  if (!value) return null;
  const date = new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}` : value);
  if (endOfDay && value instanceof Date) date.setHours(23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? null : date;
};
const iso = (value) => asDate(value)?.toISOString() || null;

// Ưu tiên lịch vòng thi, sau đó lịch cuộc thi để tính trạng thái của đề.
export function examToPayload(exam, now = new Date()) {
  const start = asDate(exam.start_datetime || exam.start_date);
  const end = asDate(exam.end_datetime || exam.end_date, !exam.end_datetime);
  const scheduled = start && end && end >= start;
  const status = exam.competition_status === 'closed' ? 'Đã đóng' : !scheduled ? 'Chưa có lịch thi' : now < start ? 'Sắp diễn ra' : now >= end ? 'Đã kết thúc' : 'Đang diễn ra';
  return {
    id: exam.id, title: exam.title, description: exam.description,
    status, date: scheduled ? `${start.toLocaleDateString('vi-VN')} - ${end.toLocaleDateString('vi-VN')}` : null,
    startAt: scheduled ? start.toISOString() : null, endAt: scheduled ? end.toISOString() : null,
    questions: Number(exam.questions), duration: `${exam.takingtime} phút`, passingScore: Number(exam.passingscore)
  };
}

// Các API đọc thông tin công khai; nhận pool từ bên ngoài để dễ kiểm thử độc lập.
export function createPublicRouter({ pool }) {
  const router = Router();
  router.get('/health', async (_request, response) => {
    // Kiểm tra kết nối thực ở mỗi yêu cầu, không chỉ dựa vào kết quả lúc khởi động.
    try {
      await pool.query('SELECT 1');
      response.json({ success: true, database: 'connected', timestamp: new Date().toISOString() });
    } catch {
      response.status(503).json({ success: false, database: 'disconnected', message: 'Không thể kết nối cơ sở dữ liệu.' });
    }
  });
  router.get('/units', async (_request, response, next) => {
    try {
      const [rows] = await pool.query('SELECT id, ten FROM donvi ORDER BY ten ASC');
      response.json({ success: true, data: rows });
    } catch (error) { next(error); }
  });
  router.get('/exams', async (_request, response, next) => {
    // Đếm câu hỏi theo đề; khi đề gắn với vòng thì lấy cuộc thi của chính vòng đó.
    try {
      const [rows] = await pool.query(`SELECT e.id, e.name AS title, e.description, e.passingscore, e.takingtime,
        (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS questions,
        COALESCE(r.start_datetime,c.start_at) AS start_datetime, COALESCE(r.end_datetime,c.end_at) AS end_datetime,
        c.start_date, c.end_date, c.status AS competition_status
        FROM exams e LEFT JOIN rounds r ON r.id = e.round_id
        LEFT JOIN competitions c ON c.id = COALESCE(r.competition_id, e.competition_id)
        WHERE e.is_published=1 AND c.status IN ('published','closed') ORDER BY e.id`);
      response.json({ success: true, data: rows.map((row) => examToPayload(row)) });
    } catch (error) { next(error); }
  });
  router.get('/dashboard', async (_request, response, next) => {
    try {
      // Chọn cuộc thi đang diễn ra, kế đến cuộc thi sắp mở gần nhất, cuối cùng là cuộc thi vừa kết thúc.
      const [[competition]] = await pool.query(`SELECT id, name, description, start_date, end_date, start_at, end_at FROM competitions
        WHERE status IN ('published','closed')
        ORDER BY CASE WHEN CURDATE() BETWEEN start_date AND end_date THEN 0 WHEN start_date > CURDATE() THEN 1 ELSE 2 END,
        CASE WHEN start_date > CURDATE() THEN start_date END ASC, end_date DESC, id DESC LIMIT 1`);
      let [rounds] = competition ? await pool.query('SELECT id, round_number, start_datetime, end_datetime FROM rounds WHERE competition_id = ? ORDER BY start_datetime, round_number', [competition.id]) : [[]];
      if (competition?.start_at && competition?.end_at && !rounds.length) rounds = [{ id: `competition-${competition.id}`, round_number: 1, start_datetime: competition.start_at, end_datetime: competition.end_at }];
      // Chỉ đọc kết quả của cuộc thi đang hiển thị; thời gian làm bài lấy từ phiên có cùng người và đề.
      const [results] = competition ? await pool.query(`SELECT r.id, u.hoten AS fullName, d.ten AS unitName, o.ten AS organizationName,
        r.score, r.finished_at AS finishedAt,
        CASE WHEN s.finished_at >= s.started_at THEN TIMESTAMPDIFF(SECOND, s.started_at, s.finished_at) ELSE NULL END AS durationSeconds
        FROM results r JOIN users u ON u.id = r.user_id JOIN exams e ON e.id = r.exam_id
        LEFT JOIN rounds rd ON rd.id = e.round_id LEFT JOIN donvi d ON d.id = u.donviID
        LEFT JOIN doancoso o ON o.id = d.doanCoSoID LEFT JOIN user_exam_sessions s ON s.id = r.session_id AND s.user_id = r.user_id AND s.exam_id = r.exam_id
        WHERE COALESCE(rd.competition_id, e.competition_id) = ?
        ORDER BY r.finished_at DESC, r.id DESC LIMIT 100`, [competition.id]) : [[]];
      // Thống kê toàn hệ thống từ dữ liệu gốc, không sử dụng các bộ đếm mẫu trong bảng statistics.
      const [[totals]] = await pool.query(`SELECT (SELECT COUNT(*) FROM users WHERE is_active = 1 AND role='candidate') AS totalRegistrations,
        (SELECT COUNT(*) FROM results) AS totalTests`);
      const [units] = await pool.query(`SELECT d.id, d.ten AS name, o.ten AS organizationName,
        (SELECT COUNT(*) FROM users u WHERE u.donviID = d.id AND u.is_active = 1 AND u.role='candidate') AS totalRegistrations,
        (SELECT COUNT(*) FROM results r JOIN users u ON u.id = r.user_id WHERE u.donviID = d.id) AS totalTests
        FROM donvi d LEFT JOIN doancoso o ON o.id = d.doanCoSoID ORDER BY d.ten`);
      response.json({ success: true, data: {
        competition: competition ? { id: competition.id, name: competition.name, description: competition.description, startDate: iso(competition.start_at || competition.start_date), endDate: competition.end_at ? iso(competition.end_at) : asDate(competition.end_date, true)?.toISOString() } : null,
        rounds: rounds.map((r) => ({ id: r.id, roundNumber: r.round_number, startAt: iso(r.start_datetime), endAt: iso(r.end_datetime) })),
        results: results.map((r) => ({ ...r, score: Number(r.score), finishedAt: iso(r.finishedAt), durationSeconds: r.durationSeconds === null ? null : Number(r.durationSeconds) })),
        statistics: { totalRegistrations: Number(totals.totalRegistrations), totalTests: Number(totals.totalTests), units: units.map((u) => ({ ...u, totalRegistrations: Number(u.totalRegistrations), totalTests: Number(u.totalTests) })) }
      } });
    } catch (error) { next(error); }
  });
  return router;
}
