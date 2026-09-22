// Kết quả gắn với tài khoản và đề; API dashboard đọc điểm từ bảng này.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Result',
  tableName: 'results',
  columns: {
    started_at: { type: 'datetime', nullable: true },
    duration_seconds: { type: Number, unsigned: true, nullable: true },
    round_rank: { type: Number, unsigned: true, nullable: true },
    advanced: { type: Boolean, nullable: true },
    id: { type: 'bigint', unsigned: true, primary: true, generated: 'increment' },
    user_id: { type: Number, unsigned: true },
    exam_id: { type: Number, unsigned: true },
    // Mỗi phiên tối đa một kết quả; NULL dành cho bản ghi cũ chưa có liên kết phiên.
    session_id: { type: 'bigint', unsigned: true, nullable: true, unique: true },
    score: { type: 'decimal', precision: 12, scale: 2, default: 0 },
    finished_at: { type: 'datetime' }
  },
  relations: {
    user: { type: 'many-to-one', target: 'User', joinColumn: { name: 'user_id' } },
    exam: { type: 'many-to-one', target: 'Exam', joinColumn: { name: 'exam_id' } },
    session: { type: 'one-to-one', target: 'UserExamSession', joinColumn: { name: 'session_id' }, nullable: true, onDelete: 'SET NULL' }
  }
});
