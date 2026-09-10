// Mô hình lưu dữ liệu phiên làm bài của một tài khoản theo đề và vòng thi.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'UserExamSession',
  tableName: 'user_exam_sessions',
  columns: {
    competition_id: { type: Number, unsigned: true, nullable: true },
    question_snapshot: { type: 'json', nullable: true },
    expires_at: { type: 'datetime', nullable: true },
    status: { type: String, length: 20, default: 'in_progress' },
    revision: { type: Number, unsigned: true, default: 0 },
    attempt_number: { type: Number, unsigned: true, default: 1 },
    updated_at: { type: 'datetime', default: () => 'CURRENT_TIMESTAMP' },
    id: { type: 'bigint', unsigned: true, primary: true, generated: 'increment' },
    user_id: { type: Number, unsigned: true },
    exam_id: { type: Number, unsigned: true },
    round_id: { type: Number, unsigned: true, nullable: true },
    // Danh sách ID chỉ tham chiếu câu hỏi, không phải bản chụp nội dung câu hỏi bất biến.
    question_ids: { type: 'json' },
    answers: { type: 'json', nullable: true },
    // Điểm và thời điểm kết thúc có thể chưa có trong phiên đang lưu dở.
    score: { type: 'decimal', precision: 5, scale: 2, nullable: true },
    started_at: { type: 'datetime', createDate: true },
    finished_at: { type: 'datetime', nullable: true }
  },
  relations: {
    user: { type: 'many-to-one', target: 'User', joinColumn: { name: 'user_id' } },
    exam: { type: 'many-to-one', target: 'Exam', joinColumn: { name: 'exam_id' } },
    round: { type: 'many-to-one', target: 'Round', joinColumn: { name: 'round_id' }, nullable: true, onDelete: 'SET NULL' }
  }
});
