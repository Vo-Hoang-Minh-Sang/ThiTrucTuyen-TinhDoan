// Câu hỏi trắc nghiệm có bốn lựa chọn và một đáp án đúng A/B/C/D.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Question',
  tableName: 'questions',
  columns: {
    round_id: { type: Number, unsigned: true, nullable: true },
    competition_id: { type: Number, unsigned: true, nullable: true },
    difficulty: { type: String, length: 20, default: 'medium' },
    points: { type: 'decimal', precision: 10, scale: 2, default: 1 },
    created_by: { type: Number, unsigned: true, nullable: true },
    archived_at: { type: 'datetime', nullable: true },
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    content: { type: 'text' },
    optionA: { type: 'text' },
    optionB: { type: 'text' },
    optionC: { type: 'text' },
    optionD: { type: 'text' },
    correctAnswer: { type: 'enum', enum: ['A', 'B', 'C', 'D'] },
    created_at: { type: 'timestamp', createDate: true }
  }
});
