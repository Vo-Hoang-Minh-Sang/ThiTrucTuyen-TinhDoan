// Lưu thời điểm tạm đóng để bù đúng thời gian cho các bài đang làm khi cuộc thi mở lại.
export class CompetitionPause1789100000000 {
  name = 'CompetitionPause1789100000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('competitions');
    if (!table.columns.some(column => column.name === 'paused_at')) {
      await runner.query('ALTER TABLE `competitions` ADD COLUMN `paused_at` DATETIME NULL');
    }
  }

  async down() {
    throw new Error('Không tự xóa thời điểm tạm đóng vì có thể làm sai hạn nộp của bài thi đang được tạm dừng.');
  }
}
