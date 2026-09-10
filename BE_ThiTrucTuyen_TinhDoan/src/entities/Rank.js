// Bảng thông tin xếp hạng đã có trong mô hình; chưa chứa nghiệp vụ tính thứ hạng.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Rank',
  tableName: 'rank',
  columns: {
    id: { type: 'bigint', unsigned: true, primary: true, generated: 'increment' },
    hoten: { type: String, length: 255 },
    dienthoai: { type: String, length: 30, nullable: true },
    email: { type: String, length: 255, nullable: true },
    donviID: { type: Number, unsigned: true, nullable: true },
    finishedat: { type: 'datetime', nullable: true }
  },
  relations: { donvi: { type: 'many-to-one', target: 'DonVi', joinColumn: { name: 'donviID' } } }
});
