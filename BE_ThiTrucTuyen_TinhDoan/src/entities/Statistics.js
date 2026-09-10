// Giữ mô hình thống kê đã khai báo; dashboard hiện đếm trực tiếp dữ liệu users/results.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Statistics',
  tableName: 'statistics',
  columns: {
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    total_registrations: { type: Number, unsigned: true, default: 0 },
    total_tests: { type: Number, unsigned: true, default: 0 },
    created_at: { type: 'timestamp', createDate: true },
    updated_at: { type: 'timestamp', updateDate: true }
  }
});
