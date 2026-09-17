// Gỡ dữ liệu dự đoán của câu hỏi phụ vì tính năng này không còn được sử dụng.
export class RemoveBonusPrediction1790000000000 {
  name = 'RemoveBonusPrediction1790000000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('user_exam_sessions');
    if (table.columns.some(column => column.name === 'bonus_answer')) {
      await runner.query('ALTER TABLE `user_exam_sessions` DROP COLUMN `bonus_answer`');
    }
  }

  async down() {
    throw new Error('Không tự khôi phục dữ liệu dự đoán đã bị xóa.');
  }
}
