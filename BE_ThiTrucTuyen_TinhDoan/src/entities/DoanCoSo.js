// Đoàn cơ sở là cấp tổ chức chứa các đơn vị trong bảng donvi.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'DoanCoSo',
  tableName: 'doancoso',
  columns: {
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    ten: { type: String, length: 255 },
    created_at: { type: 'timestamp', createDate: true }
  },
  relations: { donvis: { type: 'one-to-many', target: 'DonVi', inverseSide: 'doanCoSo' } }
});
