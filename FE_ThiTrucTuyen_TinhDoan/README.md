# Frontend Thi trực tuyến Tỉnh Đoàn

React 18 + Vite 6. Khuyến nghị Node.js 22/24.

```sh
npm ci
npm run dev
```

Mặc định frontend ở `http://localhost:5173`. Vite dev server chuyển `/api` sang backend ở `http://localhost:5000`.

## Cấu hình API và triển khai

- Mặc định `VITE_API_BASE_URL` trống: request dùng `/api` trên cùng origin.
- Khi frontend và backend khác origin, đặt `VITE_API_BASE_URL` thành origin backend, không thêm `/api`, ví dụ `https://api.example.com`. Đặt `CLIENT_URL` backend bằng origin frontend.
- Chạy `npm run build`, đưa nội dung `dist/` lên web server. Với cùng origin, reverse proxy `/api` đến backend; cấu hình proxy trong Vite chỉ dành cho development.
- Biến `VITE_*` được đưa vào bundle lúc build; không đặt mật khẩu/khóa bí mật trong đó.

## Chức năng hiện có

- Danh sách đề, lịch vòng thi, đếm ngược, kết quả thật và thống kê toàn hệ thống từ API.
- Hiển thị riêng trạng thái đang tải, không có dữ liệu, mất kết nối và nút tải lại. Không tự thay bằng dữ liệu mẫu.
- Đăng ký/xác nhận email, gửi lại OTP, đăng nhập, quên/đặt lại mật khẩu.
- Lưu token trong localStorage; khôi phục user bằng `/auth/me`, theo dõi hết hạn và kiểm tra lại khi quay lại tab; đồng bộ đăng xuất giữa các tab.
- Đăng xuất gọi backend thu hồi token, đồng thời xóa phiên cục bộ. Nếu mất mạng, giao diện thông báo chưa xác nhận thu hồi các phiên khác.
- Lỗi SMTP khi đăng ký vẫn mở bước xác nhận để người dùng gửi lại mã; mật khẩu mới tối thiểu 8 ký tự và tối đa 72 byte UTF-8.

Giao diện không hiển thị danh sách thí sinh, tin tức hoặc thống kê minh họa như dữ liệu thật. Chức năng làm bài chưa triển khai; nút được vô hiệu hóa và có thông báo rõ ràng. Kết quả hiện là 100 bản ghi mới nhất của cuộc thi đang hiển thị, chưa phải bảng xét giải.

## Cấu trúc

- `src/main.jsx`: trang thông tin, lịch và bảng dữ liệu.
- `src/AuthPanel.jsx`: các bước tài khoản và OTP.
- `src/useSession.js`: khôi phục, hết hạn, đồng bộ và đăng xuất phiên.
- `src/api.js`: URL API, Bearer token, lỗi và thời hạn request.
- `src/styles.css`: giao diện responsive, không phụ thuộc ảnh/font bên ngoài.

## Kiểm tra

```sh
npm test
npm run build
```

Test React chạy trong Node với API giả; không mở trình duyệt, không tạo tài khoản thật hoặc gửi email.
