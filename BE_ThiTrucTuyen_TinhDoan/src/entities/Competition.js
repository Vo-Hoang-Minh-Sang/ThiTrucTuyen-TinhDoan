// Cuộc thi chứa nhiều vòng; khoảng ngày là lịch tổng thể của cuộc thi.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Competition',
  tableName: 'competitions',
  columns: {
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    name: { type: String, length: 255 },
    description: { type: 'text', nullable: true },
    start_date: { type: 'date' },
    end_date: { type: 'date' },
    duration_minutes: { type: Number, unsigned: true, default: 30 },
    max_attempts: { type: Number, unsigned: true, default: 1 },
    // Điểm tối thiểu để được xét đi tiếp ở mọi vòng của kỳ thi.
    start_at: { type: 'datetime', nullable: true },
    end_at: { type: 'datetime', nullable: true },
    status: { type: String, length: 20, default: 'draft' },
    // Mốc tạm dừng dùng để gia hạn các bài đang làm khi quản trị viên mở lại kỳ thi.
    paused_at: { type: 'datetime', nullable: true },
    created_by: { type: Number, unsigned: true, nullable: true },
    created_at: { type: 'timestamp', createDate: true }
  },
  relations: { rounds: { type: 'one-to-many', target: 'Round', inverseSide: 'competition' } }
});
