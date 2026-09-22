// Tài khoản gắn với đơn vị; thông tin xác thực được xử lý trong module auth.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: 'increment', unsigned: true },
    hoten: { type: String, length: 255 },
    dienthoai: { type: String, length: 30, nullable: true, unique: true },
    email: { type: String, length: 255, nullable: true, unique: true },
    chuc_vu: { type: String, length: 100, default: 'Đoàn viên' },
    donviID: { type: Number, nullable: true, unsigned: true },
    // Chỉ lưu mật khẩu đã băm, không lưu mật khẩu người dùng nhập trực tiếp.
    password: { type: String, length: 255 },
    countLogin: { type: Number, unsigned: true, default: 0 },
    // Khi chưa dùng OTP, đăng ký mới được kích hoạt ngay; tài khoản cũ bị khóa vẫn giữ nguyên.
    is_active: { type: Boolean, default: true },
    role: { type: String, length: 20, default: 'candidate' },
    permissions: { type: 'json', nullable: true },
    must_change_password: { type: Boolean, default: false },
    // Tăng phiên bản để thu hồi các JWT đã phát hành trước đó.
    token_version: { type: Number, unsigned: true, default: 0 },
    time_register: { type: 'datetime', createDate: true }
  },
  relations: { donvi: { type: 'many-to-one', target: 'DonVi', joinColumn: { name: 'donviID' }, inverseSide: 'users' } }
});
