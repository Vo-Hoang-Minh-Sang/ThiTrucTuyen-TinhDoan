# Tài khoản và thay đổi database

OTP mặc định **tắt** (`OTP_ENABLED=false`). Đăng ký công khai tạo tài khoản thí sinh hoạt động ngay, không gửi SMS/email. Quyền và vai trò gửi thêm từ trình duyệt bị bỏ qua. Luồng OTP cũ vẫn được giữ sau cờ cấu hình cho giai đoạn sau; chưa có tích hợp SMS.

Khi quên mật khẩu, hệ thống tạo yêu cầu hỗ trợ đang chờ. Quản trị viên xác minh người yêu cầu qua quy trình của đơn vị rồi cấp mật khẩu tạm thời; người dùng phải đổi mật khẩu khi đăng nhập. Phản hồi công khai không tiết lộ tài khoản có tồn tại hay không. Các tài khoản cũ bị khóa/chưa kích hoạt vẫn giữ nguyên trạng thái, cần admin kiểm tra trước khi bật lại.

Mỗi JWT gắn một UUID trong `auth_sessions`. Đăng xuất chỉ thu hồi phiên hiện tại. Đổi mật khẩu yêu cầu mật khẩu hiện tại và thu hồi toàn bộ phiên. Mỗi yêu cầu đọc lại vai trò, quyền và trạng thái từ database; giảng viên cần quyền tương ứng và phân công trong `teacher_competitions`.

## Migration mới

`1789000000000-ExamPlatform.js` chạy sau migration nền, thêm:

| Bảng | Nội dung |
| --- | --- |
| `users` | `role`, `permissions`, `must_change_password` |
| `competitions` | thời lượng, số lượt tối đa, lịch đến giây, trạng thái, người tạo |
| `questions` | kỳ thi, chủ đề, độ khó, người tạo, thời điểm lưu trữ |
| `exams` | mã đề, bản chụp câu hỏi/đáp án, trạng thái xuất bản, người tạo |
| `user_exam_sessions` | kỳ thi, bản chụp, hạn nộp, trạng thái, phiên bản đồng bộ, lượt thi, thời điểm cập nhật |
| Bảng mới | `auth_sessions`, `password_reset_requests`, `teacher_competitions`, `competition_registrations`, `site_settings`, `site_assets`, `audit_logs` |

Migration giữ bản ghi hiện có, không tự cấp admin, không tự mở khóa tài khoản, không xuất bản kỳ thi/đề cũ. ID khóa ngoại mới lấy đúng kiểu và dấu của ID cha. Các phiên cũ đã có `finished_at` được ghi nhận `submitted`; điểm cũ không thay đổi. Cần kiểm tra lịch, phân loại câu hỏi và tạo/xuất bản đề mới trước khi mở thi. JWT phát hành trước thay đổi này thiếu mã phiên nên người dùng phải đăng nhập lại.

Hãy sao lưu database trước khi chạy `npm run db:migrate`. MySQL xác nhận từng lệnh DDL; nếu bị ngắt, sửa nguyên nhân rồi chạy lại. Không dùng `down` để xóa cột/bảng tự động. Khôi phục bản sao lưu tương ứng nếu cần quay lại phiên bản trước. `synchronize` tiếp tục tắt.

## Tạo admin đầu tiên

Chạy migration trước, sau đó từ thư mục backend:

```powershell
node scripts/bootstrap-admin.js
```

Lệnh hỏi tên, số điện thoại, email và mật khẩu (ẩn). Mật khẩu admin tối thiểu 12 ký tự, tối đa 72 byte UTF-8. Có thể truyền các biến môi trường `ADMIN_NAME`, `ADMIN_PHONE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` trong hệ thống quản lý bí mật khi chạy tự động; không ghi mật khẩu vào repository hoặc lịch sử lệnh. Không có tài khoản/mật khẩu mặc định.

Lệnh không tự chạy migration và từ chối nếu đã có admin hoặc email/điện thoại thuộc tài khoản khác. Tài khoản vừa tạo bắt buộc đổi mật khẩu trước khi thao tác nghiệp vụ. Lần tạo admin được ghi nhật ký mà không lưu mật khẩu/token.
