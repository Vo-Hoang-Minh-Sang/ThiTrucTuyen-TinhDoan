// Bảng nối nhiều-nhiều giữa đề và câu hỏi; khóa ghép ngăn thêm trùng cùng một cặp.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'ExamQuestion',
  tableName: 'exam_questions',
  columns: {
    exam_id: { type: Number, unsigned: true, primary: true },
    question_id: { type: Number, unsigned: true, primary: true }
  },
  relations: {
    exam: { type: 'many-to-one', target: 'Exam', joinColumn: { name: 'exam_id' } },
    question: { type: 'many-to-one', target: 'Question', joinColumn: { name: 'question_id' } }
  }
});
