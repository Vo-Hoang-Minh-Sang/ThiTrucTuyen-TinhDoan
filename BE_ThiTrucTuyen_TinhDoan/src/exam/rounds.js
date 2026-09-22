import { fail, positiveId } from '../common/http.js';

// Trạng thái tham gia do backend quyết định; lịch thi được trả riêng để không nhầm với quyền vào vòng.
export function roundParticipation({ round, competition, now, registered, eligible, eligibilityMessage, used, completed, activeSessionId, hasExam }) {
  const start = Math.max(new Date(round.start_datetime).getTime(), new Date(competition.start_at).getTime());
  const end = Math.min(new Date(round.end_datetime).getTime(), new Date(competition.end_at).getTime());
  const time = new Date(now).getTime();
  const scheduleStatus = !Number.isFinite(start) || !Number.isFinite(end) || end <= start ? 'unscheduled' : time < start ? 'upcoming' : time >= end ? 'ended' : 'active';
  const result = (status, message = '') => ({ status, scheduleStatus, eligibilityMessage: message });
  if (competition.status === 'paused') return result('LOCKED', 'Cuộc thi đang bị tạm dừng.');
  if (round.finalized_at || scheduleStatus === 'ended') return result(completed > 0 ? 'COMPLETED' : 'LOCKED', round.finalized_at ? 'Vòng thi đã chốt kết quả.' : 'Vòng thi đã kết thúc.');
  if (!registered) return result('LOCKED', 'Bạn cần đăng ký cuộc thi trước khi làm bài.');
  if (!eligible) return result('LOCKED', eligibilityMessage || 'Bạn chưa đủ điều kiện vào vòng này.');
  // Phiên đang làm vẫn được tiếp tục dù đã tính vào hạn mức lượt hoặc ngân hàng vừa thay đổi.
  if (activeSessionId) return result('AVAILABLE');
  if (competition.status === 'closed') return result(completed > 0 ? 'COMPLETED' : 'LOCKED', 'Cuộc thi đã đóng lượt mới.');
  if (competition.status !== 'published' || scheduleStatus !== 'active') return result('LOCKED', scheduleStatus === 'upcoming' ? 'Vòng thi chưa đến giờ bắt đầu.' : 'Vòng thi chưa có lịch hợp lệ.');
  if (used >= Number(competition.max_attempts)) return result(completed > 0 ? 'COMPLETED' : 'LOCKED', 'Bạn đã sử dụng hết số lượt của vòng này.');
  if (!hasExam) return result('LOCKED', 'Vòng thi chưa có đề được xuất bản.');
  return result('AVAILABLE');
}

export async function roundScope(db, competitionId, value) {
  const [rounds] = await db.query('SELECT * FROM rounds WHERE competition_id=? AND enabled=1 ORDER BY round_number,id', [competitionId]);
  if (!rounds.length) {
    if (value) throw fail(400, 'Vòng thi chưa được cấu hình cho cuộc thi này.');
    return null;
  }
  const id = positiveId(value, 'Vòng thi');
  const round = rounds.find(item => Number(item.id) === id);
  if (!round) throw fail(400, 'Vòng thi không thuộc cuộc thi đã chọn.');
  return round;
}

// Mỗi thí sinh lấy một bài tốt nhất; điểm, thời gian và thời điểm nộp quyết định thứ hạng.
export function rankResults(rows) {
  const sorted = [...rows].sort((a, b) => Number(b.score) - Number(a.score) || Number(a.duration_seconds) - Number(b.duration_seconds)
    || new Date(a.finished_at) - new Date(b.finished_at) || Number(a.user_id) - Number(b.user_id) || Number(a.id) - Number(b.id));
  const seen = new Set();
  return sorted.filter(row => { const id = String(row.user_id); if (seen.has(id)) return false; seen.add(id); return true; });
}

export async function finalizeRound(pool, competitionId, roundId) {
  return pool.transaction(async tx => {
    // Khóa cuộc thi cùng quy ước với cấp bài; không có lượt mới chen vào lúc chốt thứ hạng.
    // Điểm chuẩn thuộc kỳ thi, còn Top N thuộc từng vòng. Khóa cả hai dữ liệu để
    // kết quả chốt không thay đổi khi quản trị viên đang chỉnh cấu hình.
    const [[competition]] = await tx.query('SELECT id,name,status FROM competitions WHERE id=? FOR UPDATE', [competitionId]);
    if (!competition) throw fail(404, 'Không tìm thấy kỳ thi.');
    // Bản nháp chỉ là dữ liệu cấu hình, dù đã qua lịch cũng không được chốt xếp hạng hay danh sách đi tiếp.
    if (['draft', 'paused'].includes(competition.status)) throw fail(409, 'Kỳ thi đang ở trạng thái chưa thể chốt kết quả.');
    const [[round]] = await tx.query('SELECT *,CURRENT_TIMESTAMP AS server_now FROM rounds WHERE id=? AND competition_id=? AND enabled=1 FOR UPDATE', [roundId, competitionId]);
    if (!round) throw fail(404, 'Không tìm thấy vòng thi.');
    if (round.finalized_at) return { finalized: false, competitionFinished: false };
    if (new Date(round.server_now) < new Date(round.end_datetime)) throw fail(409, 'Chỉ chốt xếp hạng sau khi vòng thi kết thúc.');
    const [[pending]] = await tx.query("SELECT id FROM user_exam_sessions WHERE round_id=? AND status='in_progress' LIMIT 1", [roundId]);
    if (pending) throw fail(409, 'Còn bài chưa chấm. Vui lòng chờ hệ thống chốt bài hết giờ rồi thử lại.');
    const [rows] = await tx.query(`SELECT r.* FROM results r JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id AND s.exam_id=r.exam_id
      JOIN exams e ON e.id=s.exam_id WHERE s.round_id=? AND s.competition_id=? AND e.round_id=s.round_id
      AND r.duration_seconds IS NOT NULL AND r.finished_at>=r.started_at AND s.status IN ('submitted','expired')`, [roundId, competitionId]);
    const ranked = rankResults(rows);
    // Thí sinh đi tiếp phải đồng thời đạt điểm chuẩn và thuộc Top N. Top N bằng 0
    // nghĩa là không giới hạn số lượng, khi đó chỉ xét điều kiện điểm chuẩn.
    // ?i?u ki?n ?i ti?p ch? d?a tr?n th? h?ng Top N c?a t?ng v?ng. Top N b?ng 0 ngh?a l? kh?ng gi?i h?n.
    const topLimit = Number(round.advance_count);
    for (let i = 0; i < ranked.length; i += 1) {
      await tx.query('UPDATE results SET round_rank=?,advanced=? WHERE id=?', [i + 1, Number(topLimit === 0 || i < topLimit), ranked[i].id]);
    }
    await tx.query('UPDATE rounds SET finalized_at=CURRENT_TIMESTAMP WHERE id=?', [roundId]);
    // Chỉ sao lưu sau vòng cuối cùng; các vòng sau chưa chốt vẫn cho biết kỳ thi chưa kết thúc.
    const [[remaining]] = await tx.query('SELECT id FROM rounds WHERE competition_id=? AND enabled=1 AND id<>? AND finalized_at IS NULL LIMIT 1', [competitionId, roundId]);
    return { finalized: true, competitionFinished: !remaining, competitionName: competition.name };
  });
}

// Worker quét các vòng đã hết giờ sau khi các phiên làm bài hết hạn đã được chấm.
// Hàm có thể chạy trên nhiều tiến trình vì finalizeRound khóa vòng và bỏ qua vòng đã chốt.
export async function finalizeEndedRounds(pool, { limit = 100, onCompetitionFinished } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('INVALID_ROUND_FINALIZATION_BATCH_SIZE');
  const [rounds] = await pool.query(`SELECT r.id, r.competition_id AS competitionId FROM rounds r
    JOIN competitions c ON c.id=r.competition_id
    WHERE r.enabled=1 AND r.finalized_at IS NULL AND r.end_datetime<=CURRENT_TIMESTAMP AND c.status NOT IN ('draft','paused')
    ORDER BY r.end_datetime,r.id LIMIT ${limit}`);
  let finalized = 0;
  let waiting = 0;
  let failed = 0;
  const finishedCompetitions = [];
  for (const round of rounds) {
    try {
      const result = await finalizeRound(pool, round.competitionId, round.id);
      if (result?.finalized) finalized += 1;
      if (result?.competitionFinished) finishedCompetitions.push(result);
    } catch (error) {
      // Phiên vừa hết giờ có thể đang được worker chấm; lần quét kế tiếp sẽ chốt vòng.
      if (error.status === 409) { waiting += 1; continue; }
      failed += 1;
      console.error('Không thể tự chốt vòng thi:', round.id, error.code || error.name);
    }
  }
  // Callback chạy sau khi giao dịch chốt vòng đã hoàn tất, nên backup không giữ khóa dữ liệu thi.
  if (onCompetitionFinished) {
    for (const competition of finishedCompetitions) {
      try { await onCompetitionFinished(competition); }
      catch (error) { failed += 1; console.error('Không thể sao lưu sau khi kết thúc kỳ thi:', error.code || error.name); }
    }
  }
  return { finalized, waiting, failed };
}

export async function checkRoundEligibility(db, userId, round) {
  if (round.finalized_at) throw fail(409, 'Vòng thi đã chốt kết quả.');
  const [[previous]] = await db.query('SELECT id,finalized_at FROM rounds WHERE competition_id=? AND enabled=1 AND round_number<? ORDER BY round_number DESC,id DESC LIMIT 1', [round.competition_id, round.round_number]);
  if (!previous) return;
  if (!previous.finalized_at) throw fail(403, 'Vòng trước chưa chốt danh sách đi tiếp.', 'ROUND_NOT_QUALIFIED');
  const [[qualified]] = await db.query(`SELECT r.id FROM results r JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id AND s.exam_id=r.exam_id
    WHERE s.round_id=? AND s.competition_id=? AND r.user_id=? AND r.advanced=1 LIMIT 1`, [previous.id, round.competition_id, userId]);
  if (!qualified) throw fail(403, 'Bạn không nằm trong danh sách được vào vòng này.', 'ROUND_NOT_QUALIFIED');
}
