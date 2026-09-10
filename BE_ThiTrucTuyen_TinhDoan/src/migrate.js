// Lệnh chạy migration riêng; luôn tắt seed và đóng kết nối sau khi hoàn tất.
import { initializeDatabase, closeDatabase } from './db.js';

try {
  await initializeDatabase({ seed: false });
  console.log('Database migrations completed.');
} catch (error) {
  console.error(`Database migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
