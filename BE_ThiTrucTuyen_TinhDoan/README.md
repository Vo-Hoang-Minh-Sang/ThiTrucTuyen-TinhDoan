# Backend Thi trực tuyến Tỉnh Đoàn

Node.js (khuyến nghị 22/24), Express, TypeORM và MySQL 8. Cài dependency bằng `npm ci`.

## Cấu hình và chạy

1. Sao chép `.env.example` thành `.env` nếu chưa có; điền cấu hình MySQL. Giữ file `.env` riêng trên máy.
2. Tạo khóa JWT riêng bằng lệnh dưới, rồi đặt giá trị vào `JWT_SECRET`. Server từ chối khóa trống, khóa mẫu hoặc dưới 32 byte.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

3. Cấu hình SMTP với `MAIL_HOST`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`. `MAIL_SECURE=true` thường dùng với cổng 465; cổng 587 dùng STARTTLS.
4. Chạy migration rồi khởi động:

```sh
npm run db:migrate
npm run dev
```

`npm start` cũng kiểm tra và chạy migration còn thiếu trước khi mở cổng HTTP. Mặc định API ở `http://localhost:5000`, frontend ở `http://localhost:5173`. `TZ=Asia/Ho_Chi_Minh` giữ việc đọc DATETIME và tính lịch theo giờ Việt Nam.

Để thử OTP local mà không gửi email, đặt `OTP_DEV_MODE=true` và để trống cấu hình SMTP. Mã thử xuất hiện trong `devOtp` và giao diện. Không được bật chế độ này khi `NODE_ENV=production`. Kết nối/chào SMTP giới hạn 5 giây, socket 10 giây; API frontend có thời hạn 30 giây.

## Database và dữ liệu cũ

- Migration có phiên bản ở `src/migrations/`, được ghi nhận trong `schema_migrations`. `synchronize=false`.
- Database trống được tạo đủ 14 bảng; không cần import schema ngoài project.
- Nâng cấp thêm `users.token_version`, `exams.competition_id`, `exams.round_id`, `user_exam_sessions.round_id`, `results.session_id`.
- Giữ dữ liệu và kiểu ID đang có. Không tự gán đề thi cũ vào cuộc thi/vòng thi. Đề chưa liên kết sẽ hiện “Chưa có lịch thi”. Kết quả hiển thị theo cuộc thi cần có liên kết tương ứng.
- Email và điện thoại cần duy nhất. Nếu dữ liệu cũ trùng, migration báo lỗi trước khi đổi schema; cần xử lý các bản ghi trùng theo nghiệp vụ rồi chạy lại. Không tự xóa hay gộp người dùng.
- `results.session_id` nullable và duy nhất; khi có liên kết, API tính thời gian làm bài từ phiên thi. Kết quả cũ chưa có liên kết hiển thị “Chưa ghi nhận” thời gian.
- Migration nền không tự rollback bằng cách xóa bảng. Sao lưu database theo quy trình triển khai trước khi nâng cấp.

Hệ thống không tự tạo dữ liệu mẫu. Sau khi chạy migration, quản trị viên tạo kỳ thi, vòng thi, ngân hàng câu hỏi và đề thi từ giao diện quản lý.

## API

Tất cả response có `success`; lỗi có `message`, lỗi tài khoản có thêm `code` và có thể có `errors`, `retryAfter`.

| Phương thức | Endpoint | Chức năng |
|---|---|---|
| GET | `/api/health` | Kiểm tra kết nối DB hiện tại; trả 503 khi lỗi |
| GET | `/api/exams` | Đề thi, số câu hỏi, lịch và trạng thái tính từ DB |
| GET | `/api/units` | Đơn vị đăng ký |
| GET | `/api/dashboard` | Cuộc thi, vòng thi, tối đa 100 kết quả mới nhất và thống kê |
| POST | `/api/auth/register` | Tạo tài khoản và OTP trong cùng transaction |
| POST | `/api/auth/resend-registration` | Gửi lại OTP đăng ký với `{identifier}` |
| POST | `/api/auth/verify-registration` | Xác nhận bằng `{identifier, otp}` |
| POST | `/api/auth/login` | Đăng nhập bằng `{identifier, password}` |
| POST | `/api/auth/request-password-reset` | Yêu cầu OTP với `{identifier}` |
| POST | `/api/auth/reset-password` | Đổi mật khẩu bằng `{identifier, otp, newPassword}` |
| GET | `/api/auth/me` | Hồ sơ theo Bearer JWT |
| POST | `/api/auth/logout` | Body `{}` + Bearer JWT; thu hồi tất cả phiên của tài khoản |

Đăng ký yêu cầu họ tên, điện thoại 9–15 chữ số (có thể bắt đầu bằng `+`), email, đơn vị và mật khẩu từ 8 ký tự đến 72 byte UTF-8. Đăng nhập vẫn tương thích mật khẩu cũ ngắn hơn 8 ký tự.

SMTP lỗi sau khi tạo tài khoản trả 503 với `registrationPending=true`; frontend chuyển sang xác nhận và cho gửi lại mã. OTP lưu hash, mặc định hết hạn sau 5 phút; tối đa 5 lần thử, tiêu thụ trong transaction có khóa hàng. Gửi lại có khoảng chờ 60 giây; mã đã xác nhận không dùng lại được.

JWT dùng HS256, có `token_version`, mặc định 2 giờ. `/me` từ chối token cũ/hết hạn và tài khoản không hoạt động. Đổi mật khẩu và đăng xuất tăng phiên bản token. Đặt lại mật khẩu không tự kích hoạt tài khoản chưa xác nhận hoặc bị khóa.

Giới hạn mặc định: đăng nhập 5 lần/định danh/15 phút, cấp OTP 3 lần/định danh/15 phút, xác nhận OTP 10 lần/định danh/15 phút, kèm giới hạn IP. Bộ đếm request nằm trong một tiến trình; chạy nhiều instance cần thay bằng bộ đếm dùng chung. Khóa OTP và khoảng chờ trong DB vẫn được chia sẻ. Sau reverse proxy, chỉ đặt `TRUST_PROXY_HOPS` bằng đúng số proxy tin cậy và không cho truy cập trực tiếp backend từ bên ngoài.

Dashboard chọn cuộc thi đang diễn ra, sau đó cuộc thi sắp diễn ra gần nhất, cuối cùng cuộc thi đã kết thúc gần nhất. Kết quả là bản ghi thật trong `results`, sắp theo thời gian hoàn thành mới nhất; chưa phải chức năng xét giải/xếp hạng. Thống kê toàn hệ thống đếm tài khoản đã kích hoạt và bản ghi kết quả, không đọc các tổng số mẫu trong `statistics`.

## Kiểm tra

```sh
npm test
npm run check
```

Test mặc định dùng database/mailer giả trong bộ kiểm thử, không kết nối `.env`, không gửi email. Test MySQL thật là opt-in; xem đầu file `test/mysql.integration.test.js` để cấu hình một MySQL dành riêng cho kiểm thử.

`src/app.js` tạo Express app mà không tự chạy HTTP/DB; `src/server.js` quản lý khởi động, `src/auth.js` xử lý tài khoản, `src/public.js` xử lý dữ liệu công khai. Chưa có API làm bài/chấm bài hoặc quản trị.
