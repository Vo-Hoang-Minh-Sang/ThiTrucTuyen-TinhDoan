// Đơn vị thuộc một đoàn cơ sở và được tài khoản tham chiếu qua donviID.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'DonVi',
  tableName: 'donvi',
  columns: {
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    doanCoSoID: { type: Number, unsigned: true },
    ten: { type: String, length: 255 },
    // Giữ các bộ đếm trong mô hình cũ; dashboard hiện tính trực tiếp từ users/results.
    total_registrations: { type: Number, unsigned: true, default: 0 },
    total_tests: { type: Number, unsigned: true, default: 0 },
    created_at: { type: 'timestamp', createDate: true }
  },
  relations: { doanCoSo: { type: 'many-to-one', target: 'DoanCoSo', joinColumn: { name: 'doanCoSoID' }, inverseSide: 'donvis' } }
});
