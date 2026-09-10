# Hợp đồng triển khai chức năng

Đây là quy ước nội bộ giữa backend và frontend. Comment trong mã viết bằng tiếng Việt.

## Quyền
- `role`: candidate / teacher / admin. Đăng ký công khai chỉ tạo candidate.
- `permissions`: mảng JSON gồm questions, exams, candidates, reports. Admin có tất cả; teacher cần quyền tương ứng và bản ghi teacher_competitions.
- Access middleware: `createAccess({pool,env})` trả hàm middleware xác thực, gắn `req.user` (đầy đủ role, permissions đã parse), `req.auth` JWT. Export `requireRoles(...roles)`, `assertCompetitionAccess(pool,user,competitionId,permission)` (throw lỗi status 403).
- Auth: các endpoint hiện có; thêm POST /auth/change-password {currentPassword,newPassword}; OTP mặc định tắt, đăng ký kích hoạt ngay; quên mật khẩu tạo yêu cầu hỗ trợ; logout chỉ thu hồi auth_sessions.jti hiện tại. must_change_password chặn nghiệp vụ, cho phép me/change-password/logout.

## Schema bổ sung (migration mới, không sửa baseline)
- users: role VARCHAR(20) NOT NULL DEFAULT 'candidate', permissions JSON NULL, must_change_password BOOLEAN NOT NULL DEFAULT 0.
- auth_sessions: id VARCHAR(36) PK, user_id cùng kiểu users.id, expires_at DATETIME, revoked_at DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP.
- password_reset_requests: id BIGINT UNSIGNED PK AUTO, user_id, status VARCHAR(20) DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME NULL, resolved_by user-id NULL.
- teacher_competitions: user_id, competition_id, PK cả hai.
- competitions: duration_minutes INT UNSIGNED DEFAULT 30, max_attempts INT UNSIGNED DEFAULT 1, start_at/end_at DATETIME NULL, status VARCHAR(20) DEFAULT 'draft', created_by user-id NULL. Giữ start_date/end_date cũ; API cập nhật cả hai.
- questions: competition_id NULL, topic VARCHAR(120) DEFAULT 'Chung', difficulty VARCHAR(20) DEFAULT 'medium', created_by NULL, archived_at DATETIME NULL.
- exams: code VARCHAR(40) NULL, question_snapshot JSON NULL, is_published BOOLEAN DEFAULT 0, created_by NULL. Snapshot gồm id,content,optionA..D,correctAnswer,topic,difficulty.
- competition_registrations: user_id, competition_id PK cả hai, unit_id NULL, registered_at DATETIME DEFAULT CURRENT_TIMESTAMP.
- user_exam_sessions: competition_id NULL, question_snapshot JSON NULL, expires_at DATETIME NULL, status VARCHAR(20) DEFAULT 'in_progress', revision INT UNSIGNED DEFAULT 0, attempt_number INT UNSIGNED DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP. Giữ question_ids/answers/score/started_at/finished_at cũ.
- site_settings: id INT UNSIGNED PK, title VARCHAR(255), description TEXT NULL, banner_url VARCHAR(255) NULL, news_url VARCHAR(255) NULL, news_title VARCHAR(255) NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP.
- site_assets: id VARCHAR(36) PK, original_name VARCHAR(255), kind VARCHAR(20), mime_type VARCHAR(100), path VARCHAR(255), created_by, created_at DATETIME DEFAULT CURRENT_TIMESTAMP.
- audit_logs: id BIGINT UNSIGNED AUTO PK, actor_id NULL, action VARCHAR(80), target_type VARCHAR(50), target_id VARCHAR(64) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP. Không ghi mật khẩu/đáp án/token.

## API quản trị (root)
Trả JSON {success:true,items:[]} cho danh sách; {success:true,item:{}} cho đơn lẻ; lỗi {success:false,message,code?}.
- GET /manage/competitions; POST /manage/competitions {name,description,durationMinutes,maxAttempts,startAt,endAt,status}; PUT /manage/competitions/:id cùng dữ liệu. GET danh sách trả id,name,description,durationMinutes,maxAttempts,startAt,endAt,status.
- GET /manage/questions?competitionId=&q=&topic=&difficulty=; GET /manage/questions/:id; POST /manage/questions; PUT /manage/questions/:id; DELETE /manage/questions/:id. Dữ liệu {competitionId,content,optionA,optionB,optionC,optionD,correctAnswer,topic,difficulty}. Luôn chọn kỳ thi khi tạo, teacher chỉ trong phạm vi phân công.
- POST /manage/questions/import?competitionId= multipart file xlsx; GET /manage/questions/template tải XLSX. Header: content,optionA,optionB,optionC,optionD,correctAnswer,topic,difficulty. Tối đa 500 dòng. Import giao dịch tất cả hoặc không lưu.
- POST /manage/exams/preview {competitionId,count,topic?,difficulty?,quantity:1..20} -> {success:true,items:[{name,questions:[snapshot]}]}. POST /manage/exams {competitionId,items:[{name,questionIds:[]}]} -> lưu và xuất bản các đề với snapshot từ DB, không tin đáp án client.
- GET /manage/exams?competitionId= -> items {id,name,code,questionCount,isPublished}.
- GET /manage/candidates?competitionId=&q=&unitId= -> items {id,hoten,dienthoai,email,unitName,competitionName,registeredAt}.
- GET /manage/users?q= -> items hồ sơ + role,permissions,competitionIds,must_change_password,is_active.
- POST /manage/users {hoten,dienthoai,email,donviID?,role:'teacher'|'candidate',permissions:[],competitionIds:[]} -> item + temporaryPassword (hiển thị một lần).
- PUT /manage/users/:id/access {role,permissions,competitionIds,is_active}.
- GET /manage/password-requests -> items {id,userId,hoten,dienthoai,email,createdAt,status}.
- POST /manage/users/:id/reset-password {requestId?} -> temporaryPassword, bắt đổi, thu hồi phiên.
- GET /manage/units -> items; POST /manage/units {ten,organizationName?}.
- GET /site -> {success:true,item:{title,description,bannerUrl,newsUrl,newsTitle}} công khai.
- POST /manage/assets multipart file + kind ('banner'|'news') -> {success:true,item:{url,name,kind}}; PUT /manage/site {title,description,bannerUrl,newsUrl,newsTitle}. Chỉ URL asset đã tải lên. Banner png/jpeg/webp; news pdf/txt/docx; giới hạn 5MB.
- GET /reports?competitionId=&from=YYYY-MM-DD&to=YYYY-MM-DD -> {success:true,summary:{registrations,attempts,completed,averageScore},units:[{id,name,registrations,attempts,completed,averageScore}]}; candidate xem tổng hợp công khai, teacher phạm vi được phân công + reports; GET /reports/export cùng filter trả XLSX chỉ teacher/admin.

## API thí sinh (exam agent)
Mọi endpoint xác thực. Các list dùng items, đơn dùng item.
- GET /candidate/competitions?from=&to= -> items {id,name,description,startAt,endAt,durationMinutes,maxAttempts,attemptsUsed,attemptsRemaining,registered,activeSessionId,status}. Chỉ published; hiển thị trạng thái theo thời gian.
- POST /candidate/competitions/:id/register {} -> item (đăng ký kỳ thi một lần).
- POST /candidate/competitions/:id/start {} -> item phiên; cần candidate, lịch hợp lệ, đăng ký tự động nếu chưa có; hết lượt báo 409. Trả lại phiên đang làm nếu có.
- GET /candidate/sessions/:id -> item phiên.
- PUT /candidate/sessions/:id/answers {answers:{questionId:'A'|'B'|'C'|'D'},revision:N} -> item; revision optimistic, conflict 409 kèm item mới. Cho xóa bằng bỏ khóa trong full answers map.
- POST /candidate/sessions/:id/submit {answers?,revision?} -> item; nộp lặp trả cùng kết quả. Hết giờ chỉ chấm dữ liệu đã lưu đúng hạn.
- GET /candidate/results?competitionId= -> items kết quả {id,sessionId,competitionId,competitionName,examName,attemptNumber,score,finishedAt}.
- Item phiên: {id,competitionId,competitionName,examId,examName,examCode,questions:[{id,content,optionA..D}],answers:{},revision,startedAt,expiresAt,serverNow,status:'in_progress'|'submitted'|'expired',score,attemptNumber}. Không gửi correctAnswer.
- Export `createCandidateRouter({pool})`; dùng createAccess. Export `finalizeExpiredSessions(pool)` cho server gọi mỗi 15 giây, chống nộp trùng bằng khóa phiên + unique results.session_id. Root gắn router và worker.

## Phân công file
- auth_schema agent: auth.js, access.js, security.js nếu cần, migration mới, entities, data-source.js, script bootstrap-admin.js, test auth/migration và README auth/schema riêng.
- exam agent: candidate.js + exam-service.js nếu cần, test candidate/exam riêng. Không sửa app/server.
- frontend agent: toàn bộ FE; root không sửa FE khi agent đang làm.
- root: manage.js, reports.js, assets.js, app/server integration, dependencies BE, docs/backup/live tests.
