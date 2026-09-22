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
  const status = exam.competition_status === 'paused' ? 'Tạm đóng' : exam.competition_status === 'closed' ? 'Đã đóng' : !scheduled ? 'Chưa có lịch thi' : now < start ? 'Sắp diễn ra' : now >= end ? 'Đã kết thúc' : 'Đang diễn ra';
  return {
    id: exam.id, title: exam.title, description: exam.description,
    status, date: scheduled ? `${start.toLocaleDateString('vi-VN')} - ${end.toLocaleDateString('vi-VN')}` : null,
    startAt: scheduled ? start.toISOString() : null, endAt: scheduled ? end.toISOString() : null,
    questions: Number(exam.questions), duration: `${exam.takingtime} phút`
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
  router.get('/competitions', async (_request, response, next) => {
    try {
      const [rows] = await pool.query(`SELECT c.id, c.name, c.description, c.duration_minutes, c.max_attempts,
        c.start_at, c.end_at, c.start_date, c.end_date, c.status,
        (SELECT COUNT(*) FROM exams e WHERE e.competition_id = c.id AND e.is_published = 1) AS exam_count
        FROM competitions c WHERE c.status IN ('published','paused','closed') ORDER BY c.start_at, c.start_date, c.id`);
      const data = await Promise.all(rows.map(async row => {
        // Trả tên vòng để lịch trình công khai hiển thị đúng tên do ban tổ chức đặt.
        const [rounds] = await pool.query('SELECT id,name,round_number,start_datetime,end_datetime,finalized_at FROM rounds WHERE competition_id=? ORDER BY round_number', [row.id]);
        return {
        id: row.id, name: row.name, description: row.description || '',
        durationMinutes: Number(row.duration_minutes), maxAttempts: Number(row.max_attempts),
        startAt: iso(row.start_at || row.start_date), endAt: row.end_at ? iso(row.end_at) : asDate(row.end_date, true)?.toISOString(),
        status: row.status, examCount: Number(row.exam_count), rounds: rounds.map(round => ({ id: round.id, name: round.name, roundNumber: Number(round.round_number), startAt: iso(round.start_datetime), endAt: iso(round.end_datetime) }))
        };
      }));
      response.json({ success: true, data });
    } catch (error) { next(error); }
  });
  router.get('/exams', async (_request, response, next) => {
    // Đếm câu hỏi theo đề; khi đề gắn với vòng thì lấy cuộc thi của chính vòng đó.
    try {
      const [rows] = await pool.query(`SELECT e.id, e.name AS title, e.description, e.takingtime,
        (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS questions,
        COALESCE(r.start_datetime,c.start_at) AS start_datetime, COALESCE(r.end_datetime,c.end_at) AS end_datetime,
        c.start_date, c.end_date, c.status AS competition_status
        FROM exams e LEFT JOIN rounds r ON r.id = e.round_id
        LEFT JOIN competitions c ON c.id = COALESCE(r.competition_id, e.competition_id)
        WHERE e.is_published=1 AND c.status IN ('published','paused','closed') ORDER BY e.id`);
      response.json({ success: true, data: rows.map((row) => examToPayload(row)) });
    } catch (error) { next(error); }
  });
  router.get('/dashboard', async (_request, response, next) => {
    try {
      // Chọn cuộc thi đang diễn ra, kế đến cuộc thi sắp mở gần nhất, cuối cùng là cuộc thi vừa kết thúc.
      const [[setting]] = await pool.query('SELECT pinned_competition_id FROM site_settings WHERE id=1');
      const pinnedId = setting?.pinned_competition_id || null;
      const [[competition]] = await pool.query(`SELECT id, name, description, start_date, end_date, start_at, end_at FROM competitions
        WHERE status IN ('published','paused','closed')
        ${pinnedId ? 'AND id=?' : ''}
        ORDER BY CASE WHEN CURDATE() BETWEEN start_date AND end_date THEN 0 WHEN start_date > CURDATE() THEN 1 ELSE 2 END,
        CASE WHEN start_date > CURDATE() THEN start_date END ASC, end_date DESC, id DESC LIMIT 1`, pinnedId ? [pinnedId] : []);
      // Lịch trình trang chủ cần tên vòng thay vì chỉ hiển thị số thứ tự.
      let [rounds] = competition ? await pool.query('SELECT id, name, round_number, start_datetime, end_datetime, finalized_at FROM rounds WHERE competition_id = ? ORDER BY start_datetime, round_number', [competition.id]) : [[]];
      if (competition?.start_at && competition?.end_at && !rounds.length) rounds = [{ id: `competition-${competition.id}`, name: 'Vòng thi', round_number: 1, start_datetime: competition.start_at, end_datetime: competition.end_at }];
      const now = new Date();
      const activeRound = rounds.find(round => now >= asDate(round.start_datetime) && now < asDate(round.end_datetime));
      const upcomingRound = rounds.find(round => now < asDate(round.start_datetime));
      const endedRound = [...rounds].reverse().find(round => now >= asDate(round.end_datetime));
      const currentRound = activeRound || upcomingRound || endedRound || null;
      const finalRound = rounds.at(-1) || null;
      let roundCandidates = { type: null, round: null, items: [] };
      if (competition && currentRound) {
        // Sau vòng cuối, công bố bảng xếp hạng đã chốt của vòng đó thay cho danh sách dự thi vòng tiếp theo.
        if (endedRound && !activeRound && !upcomingRound && Number(endedRound.id) === Number(finalRound?.id)) {
          const [completed] = await pool.query(`SELECT r.round_rank AS roundRank,u.id AS userId,u.hoten AS fullName,d.ten AS unitName,
            r.score,r.duration_seconds AS durationSeconds
            FROM results r JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id AND s.exam_id=r.exam_id
            JOIN users u ON u.id=r.user_id LEFT JOIN donvi d ON d.id=u.donviID
            WHERE s.competition_id=? AND s.round_id=? AND r.round_rank IS NOT NULL
            ORDER BY r.round_rank,r.id`, [competition.id, endedRound.id]);
          let items = completed;
          if (endedRound.finalized_at) {
            // Người đủ điều kiện nhưng không mở bài vẫn được công bố với điểm 0.
            // Chỉ ghép vào dữ liệu trả về, không tạo kết quả hoặc lượt thi không có thật.
            const previousRound = rounds.filter(round => Number(round.round_number) < Number(endedRound.round_number)).at(-1);
            const [eligible] = previousRound
              ? await pool.query(`SELECT DISTINCT r.user_id AS userId,u.hoten AS fullName,d.ten AS unitName FROM results r
                JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id JOIN users u ON u.id=r.user_id
                LEFT JOIN donvi d ON d.id=u.donviID WHERE s.competition_id=? AND s.round_id=? AND r.advanced=1 ORDER BY u.hoten,userId`, [competition.id, previousRound.id])
              : await pool.query(`SELECT cr.user_id AS userId,u.hoten AS fullName,d.ten AS unitName FROM competition_registrations cr
                JOIN users u ON u.id=cr.user_id LEFT JOIN donvi d ON d.id=cr.unit_id WHERE cr.competition_id=? ORDER BY u.hoten,u.id`, [competition.id]);
            const completedUsers = new Set(completed.map(item => String(item.userId)));
            items = [...completed, ...eligible.filter(item => !completedUsers.has(String(item.userId))).map((item, index) => ({
              ...item, roundRank: completed.length + index + 1, score: 0, durationSeconds: null
            }))];
          }
          roundCandidates = { type: 'ranking', round: endedRound, items };
        } else {
          const sourceRound = endedRound || (Number(currentRound.round_number) > 1 ? rounds.filter(round => Number(round.round_number) < Number(currentRound.round_number)).at(-1) : null);
          if (sourceRound) {
            const [items] = await pool.query(`SELECT DISTINCT u.id,u.hoten AS fullName,u.email,u.dienthoai AS phone,d.ten AS unitName,o.ten AS organizationName FROM results r
              JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id JOIN users u ON u.id=r.user_id LEFT JOIN donvi d ON d.id=u.donviID LEFT JOIN doancoso o ON o.id=d.doanCoSoID
              WHERE s.competition_id=? AND s.round_id=? AND r.advanced=1 ORDER BY u.hoten,u.id`, [competition.id, sourceRound.id]);
            roundCandidates = { type: 'advanced', round: sourceRound, items };
          } else {
            const [items] = await pool.query(`SELECT u.id,u.hoten AS fullName,u.email,u.dienthoai AS phone,d.ten AS unitName,o.ten AS organizationName FROM competition_registrations cr
              JOIN users u ON u.id=cr.user_id LEFT JOIN donvi d ON d.id=cr.unit_id LEFT JOIN doancoso o ON o.id=d.doanCoSoID WHERE cr.competition_id=? ORDER BY u.hoten,u.id`, [competition.id]);
            roundCandidates = { type: 'registered', round: currentRound, items };
          }
        }
      }
      // Chỉ đọc kết quả của cuộc thi đang hiển thị; thời gian làm bài lấy từ phiên có cùng người và đề.
      const [results] = competition ? await pool.query(`SELECT r.id, u.hoten AS fullName, d.ten AS unitName, o.ten AS organizationName,
        r.score, r.finished_at AS finishedAt,
        CASE WHEN s.finished_at >= s.started_at THEN TIMESTAMPDIFF(SECOND, s.started_at, s.finished_at) ELSE NULL END AS durationSeconds
        FROM results r JOIN users u ON u.id = r.user_id JOIN exams e ON e.id = r.exam_id
        LEFT JOIN rounds rd ON rd.id = e.round_id LEFT JOIN donvi d ON d.id = u.donviID
        LEFT JOIN doancoso o ON o.id = d.doanCoSoID LEFT JOIN user_exam_sessions s ON s.id = r.session_id AND s.user_id = r.user_id AND s.exam_id = r.exam_id
        WHERE COALESCE(rd.competition_id, e.competition_id) = ?
        ORDER BY r.finished_at DESC, r.id DESC LIMIT 100`, [competition.id]) : [[]];
      // Chỉ thống kê dữ liệu của kỳ thi đang hiển thị, không cộng lượt thi của kỳ thi khác.
      // Một phiên làm bài là một lượt thi; vì vậy cùng một thí sinh có thể tạo nhiều lượt khi được thi lại hoặc thi nhiều vòng.
      const [[totals]] = competition ? await pool.query(`SELECT
        (SELECT COUNT(*) FROM competition_registrations WHERE competition_id=?) AS totalRegistrations,
        (SELECT COUNT(*) FROM user_exam_sessions s
          JOIN exams e ON e.id=s.exam_id LEFT JOIN rounds rd ON rd.id=COALESCE(s.round_id,e.round_id)
          WHERE COALESCE(s.competition_id,rd.competition_id,e.competition_id)=?) AS totalTests`, [competition.id, competition.id]) : [[{ totalRegistrations: 0, totalTests: 0 }]];
      const [units] = competition ? await pool.query(`SELECT d.id, d.ten AS name, o.ten AS organizationName,
        (SELECT COUNT(*) FROM competition_registrations cr WHERE cr.competition_id=? AND cr.unit_id=d.id) AS totalRegistrations,
        (SELECT COUNT(*) FROM user_exam_sessions s JOIN exams e ON e.id=s.exam_id
          LEFT JOIN rounds rd ON rd.id=COALESCE(s.round_id,e.round_id) JOIN users u ON u.id=s.user_id
          WHERE u.donviID=d.id AND COALESCE(s.competition_id,rd.competition_id,e.competition_id)=?) AS totalTests
        FROM donvi d LEFT JOIN doancoso o ON o.id = d.doanCoSoID ORDER BY d.ten`, [competition.id, competition.id]) : [[]];
      response.json({ success: true, data: {
        // Frontend cần biết rõ cuộc thi đang được ghim để vẫn hiển thị số liệu sau khi kỳ thi kết thúc.
        competition: competition ? { id: competition.id, name: competition.name, description: competition.description, pinned: String(competition.id) === String(pinnedId), startDate: iso(competition.start_at || competition.start_date), endDate: competition.end_at ? iso(competition.end_at) : asDate(competition.end_date, true)?.toISOString() } : null,
        rounds: rounds.map((r) => ({ id: r.id, name: r.name, roundNumber: r.round_number, startAt: iso(r.start_datetime), endAt: iso(r.end_datetime) })),
        roundCandidates: { type: roundCandidates.type, roundNumber: roundCandidates.round ? Number(roundCandidates.round.round_number) : null, roundName: roundCandidates.round?.name || null, items: roundCandidates.items.map(item => ({ ...item, ...(item.id ? { id: Number(item.id) } : {}), ...(item.roundRank == null ? {} : { roundRank: Number(item.roundRank) }), ...(item.score == null ? {} : { score: Number(item.score) }), ...(item.durationSeconds == null ? {} : { durationSeconds: Number(item.durationSeconds) }) })) },
        results: results.map((r) => ({ ...r, score: Number(r.score), finishedAt: iso(r.finishedAt), durationSeconds: r.durationSeconds === null ? null : Number(r.durationSeconds) })),
        statistics: { totalRegistrations: Number(totals.totalRegistrations), totalTests: Number(totals.totalTests), units: units.map((u) => ({ ...u, totalRegistrations: Number(u.totalRegistrations), totalTests: Number(u.totalTests) })) }
      } });
    } catch (error) { next(error); }
  });
  return router;
}
