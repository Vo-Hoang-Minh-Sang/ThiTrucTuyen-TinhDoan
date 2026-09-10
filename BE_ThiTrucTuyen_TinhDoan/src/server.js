import dotenv from 'dotenv';
import { createApp } from './app.js';
import { validateAuthConfiguration } from './auth.js';
import { closeDatabase, initializeDatabase, pool } from './db.js';
import { sendOtpEmail } from './mailer.js';
import { finalizeExpiredSessions } from './exam-service.js';

dotenv.config();
let server;
let expiryTimer;
let expiryRun;
function checkExpired() {
  // Không chạy chồng các đợt quét; khóa bản ghi và ràng buộc kết quả vẫn bảo vệ khi có nhiều máy chủ.
  if (expiryRun) return;
  expiryRun = finalizeExpiredSessions(pool).then(result => {
    if (result.failed) console.error('Có bài hết giờ chưa chốt được; sẽ thử lại ở đợt sau.');
  }).catch(error => console.error('Exam expiry worker:', error.code || error.name)).finally(() => { expiryRun = null; });
}
async function startServer() {
  try {
    // Kiểm tra cấu hình xác thực trước khi khởi tạo dữ liệu; chỉ nhận yêu cầu khi cơ sở dữ liệu sẵn sàng.
    validateAuthConfiguration();
    await initializeDatabase();
    const port = Number(process.env.PORT || 5000);
    server = createApp({ pool, sendOtpEmail }).listen(port, () => console.log(`BE running at http://localhost:${port}`));
    checkExpired();
    expiryTimer = setInterval(checkExpired, 15000);
    expiryTimer.unref();
    server.on('error', async (error) => {
      clearInterval(expiryTimer);
      if (expiryRun) await expiryRun;
      console.error('HTTP server startup failed:', error.message);
      await closeDatabase();
      process.exitCode = 1;
    });
  } catch (error) {
    console.error('Backend startup failed:', error.message);
    await closeDatabase();
    process.exitCode = 1;
  }
}
// Ngừng nhận yêu cầu và chờ máy chủ HTTP đóng trước khi giải phóng kết nối cơ sở dữ liệu.
async function shutdown() {
  clearInterval(expiryTimer);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (expiryRun) await expiryRun;
  await closeDatabase();
}
process.once('SIGINT', () => shutdown().catch(console.error));
process.once('SIGTERM', () => shutdown().catch(console.error));
startServer();
