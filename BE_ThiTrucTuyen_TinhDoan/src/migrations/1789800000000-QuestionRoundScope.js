// Phân các câu hỏi cũ chưa có vòng vào vòng đầu tiên để tiếp tục sử dụng sau khi tách ngân hàng theo vòng.
export class QuestionRoundScope1789800000000 {
  name = 'QuestionRoundScope1789800000000';
  transaction = false;

  async up(runner) {
    const competitions = await runner.query('SELECT DISTINCT competition_id FROM questions WHERE round_id IS NULL AND competition_id IS NOT NULL');
    for (const competition of competitions) {
      // Dữ liệu cũ không lưu vòng; chọn vòng có số thứ tự nhỏ nhất là cách chuyển đổi duy nhất, ổn định và không xóa dữ liệu.
      const rounds = await runner.query('SELECT id FROM rounds WHERE competition_id=? ORDER BY round_number,id LIMIT 1', [competition.competition_id]);
      if (!rounds[0]) continue;
      await runner.query('UPDATE questions SET round_id=? WHERE competition_id=? AND round_id IS NULL', [rounds[0].id, competition.competition_id]);
    }
  }

  async down() {
    throw new Error('Không tự xóa liên kết vòng của câu hỏi vì không thể phân biệt dữ liệu cũ với dữ liệu đã nhập mới.');
  }
}
