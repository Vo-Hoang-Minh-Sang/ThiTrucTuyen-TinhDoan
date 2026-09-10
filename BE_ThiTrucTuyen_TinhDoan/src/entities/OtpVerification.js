// Lưu OTP đã băm, tách mục đích xác nhận đăng ký và đặt lại mật khẩu.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'OtpVerification',
  tableName: 'otp_verifications',
  columns: {
    id: { type: 'bigint', unsigned: true, primary: true, generated: 'increment' },
    user_id: { type: Number, unsigned: true },
    purpose: { type: 'enum', enum: ['register', 'reset_password'] },
    otp_hash: { type: String, length: 255 },
    expires_at: { type: 'datetime' },
    attempts: { type: Number, unsigned: true, default: 0 },
    // Mã đã dùng hoặc bị thay thế đều được đánh dấu để không xác nhận lại.
    verified_at: { type: 'datetime', nullable: true },
    created_at: { type: 'timestamp', createDate: true }
  },
  relations: { user: { type: 'many-to-one', target: 'User', joinColumn: { name: 'user_id' } } }
});
