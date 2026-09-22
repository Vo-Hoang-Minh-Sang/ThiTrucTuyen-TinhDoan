// Đề thi lưu cấu hình thời lượng, ngưỡng điểm và liên kết tới lịch tổ chức thi.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Exam',
  tableName: 'exams',
  columns: {
    code: { type: String, length: 40, nullable: true },
    // Bản chụp đáp án và nội dung bảo vệ đề đã xuất bản khi ngân hàng câu hỏi thay đổi.
    question_snapshot: { type: 'json', nullable: true },
    is_published: { type: Boolean, default: false },
    created_by: { type: Number, unsigned: true, nullable: true },
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    name: { type: String, length: 255 },
    description: { type: 'text', nullable: true },
    // Thời lượng được tính bằng phút khi hiển thị qua API.
    takingtime: { type: Number, unsigned: true, default: 15 },
    // Cho phép NULL để giữ tương thích với đề cũ chưa được gắn cuộc thi/vòng thi.
    competition_id: { type: Number, unsigned: true, nullable: true },
    round_id: { type: Number, unsigned: true, nullable: true },
    created_at: { type: 'timestamp', createDate: true }
  },
  relations: {
    competition: { type: 'many-to-one', target: 'Competition', joinColumn: { name: 'competition_id' }, nullable: true, onDelete: 'SET NULL' },
    round: { type: 'many-to-one', target: 'Round', joinColumn: { name: 'round_id' }, nullable: true, onDelete: 'SET NULL' }
  }
});
