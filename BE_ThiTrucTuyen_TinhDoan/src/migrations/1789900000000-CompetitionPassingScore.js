// Bổ sung điểm chuẩn cấp kỳ thi. Giá trị 0 giữ nguyên hành vi cũ: chỉ xét Top N.
export class CompetitionPassingScore1789900000000 {
  name = 'CompetitionPassingScore1789900000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('competitions');
    if (!table.columns.some(column => column.name === 'passing_score')) {
      await runner.query('ALTER TABLE `competitions` ADD COLUMN `passing_score` DECIMAL(5,2) NOT NULL DEFAULT 0');
    }
  }

  async down() {
    throw new Error('Không tự xóa điểm chuẩn vì có thể làm thay đổi điều kiện xét vòng đã công bố.');
  }
}
