// Lưu dự đoán phụ của thí sinh tách khỏi đáp án trắc nghiệm để không ảnh hưởng điểm bài thi.
export class BonusPrediction1789700000000 {
  name = 'BonusPrediction1789700000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('user_exam_sessions');
    if (!table.columns.some(column => column.name === 'bonus_answer')) {
      await runner.query('ALTER TABLE `user_exam_sessions` ADD COLUMN `bonus_answer` INT UNSIGNED NULL');
    }
  }

  async down() {
    throw new Error('Không tự xóa dự đoán phụ vì có thể làm thay đổi thứ hạng đã công bố.');
  }
}
