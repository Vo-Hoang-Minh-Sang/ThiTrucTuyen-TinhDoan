// Giữ bảng đặt lại mật khẩu theo khóa cũ; luồng OTP hiện tại dùng otp_verifications.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'PasswordResetTemp',
  tableName: 'password_reset_temp',
  columns: {
    email: { type: String, primary: true },
    expDate: { type: 'datetime' },
    key: { type: String, length: 255, unique: true }
  },
  relations: { user: { type: 'one-to-one', target: 'User', joinColumn: { name: 'email', referencedColumnName: 'email' } } }
});
