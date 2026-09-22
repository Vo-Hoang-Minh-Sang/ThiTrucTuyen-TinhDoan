// Bỏ thuộc tính chủ đề khỏi ngân hàng câu hỏi theo nghiệp vụ hiện tại.
export class RemoveQuestionTopic1790100000000 {
  name = 'RemoveQuestionTopic1790100000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('questions');
    if (table.columns.some(column => column.name === 'topic')) {
      await runner.query('ALTER TABLE `questions` DROP COLUMN `topic`');
    }
  }

  async down() {
    throw new Error('Không tự khôi phục dữ liệu chủ đề đã bị xóa.');
  }
}
