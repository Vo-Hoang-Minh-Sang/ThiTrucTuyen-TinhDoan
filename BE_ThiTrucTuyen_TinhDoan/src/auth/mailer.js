import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

let transporter;

// Tái sử dụng đối tượng gửi thư; trả về null khi chưa có đủ thông tin xác thực SMTP.
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.MAIL_HOST || !process.env.MAIL_USER || !process.env.MAIL_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: process.env.MAIL_SECURE === 'true',
    // Giới hạn thời gian chờ từng giai đoạn để lỗi SMTP không giữ yêu cầu quá lâu.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD
    }
  });
  return transporter;
}

// Gửi OTP qua email theo mục đích đăng ký hoặc đặt lại mật khẩu.
export async function sendOtpEmail({ to, otp, purpose }) {
  const transport = getTransporter();
  if (!transport) {
    // Chế độ thử nghiệm cho phép kiểm tra OTP khi chưa có SMTP; cấu hình khởi động cấm chế độ này ở production.
    if (process.env.OTP_DEV_MODE === 'true') {
      console.log(`[OTP DEV] Email SMTP chưa cấu hình. to=${to} purpose=${purpose} otp=${otp}`);
      return { delivered: false, development: true };
    }
    throw new Error('Chưa cấu hình SMTP email. Hãy điền MAIL_HOST, MAIL_USER và MAIL_PASSWORD trong .env.');
  }

  const subject = purpose === 'register' ? 'Mã OTP xác nhận đăng ký tài khoản' : 'Mã OTP đặt lại mật khẩu';
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to,
    subject,
    text: `Mã OTP của bạn là ${otp}. Mã có hiệu lực trong ${process.env.OTP_EXPIRES_MINUTES || 5} phút. Nếu không yêu cầu thao tác này, hãy bỏ qua email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Thi trực tuyến Tỉnh Đoàn Vĩnh Long</h2><p>Mã OTP của bạn là:</p><p style="font-size:28px;font-weight:bold;letter-spacing:8px;color:#1976d2">${otp}</p><p>Mã có hiệu lực trong ${process.env.OTP_EXPIRES_MINUTES || 5} phút.</p><p>Nếu bạn không yêu cầu thao tác này, hãy bỏ qua email.</p></div>`
  });
  return { delivered: true, development: false };
}
