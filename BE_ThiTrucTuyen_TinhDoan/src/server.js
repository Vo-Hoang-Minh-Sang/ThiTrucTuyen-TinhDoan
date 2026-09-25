import dotenv from 'dotenv';
import { createApp } from './app.js';
import { validateAuthConfiguration } from './auth/auth.js';
import { closeDatabase, initializeDatabase, pool } from './db.js';
import { sendOtpEmail } from './auth/mailer.js';
import { finalizeExpiredSessions } from './exam/exam-service.js';
import { finalizeEndedRounds } from './exam/rounds.js';
import { createDatabaseBackup, databaseBackupAvailable } from './common/database-backup.js';

dotenv.config();
let server;
let expiryTimer;
let expiryRun;
const FINALIZATION_BATCH_SIZE = 25;
const FINALIZATION_CONTINUE_DELAY = 1_000;
const backupQueue = [];
let backupRunning = false;
let backupAvailability;
let expiryContinuation;

// Sao luu sau khi ket thuc ky thi chay tach khoi worker cham bai de khong lam nghen API.
async function backupIsAvailable() {
  if (backupAvailability === undefined) backupAvailability = databaseBackupAvailable();
  return backupAvailability;
}

function queueCompetitionBackup(competition) {
  // Vong da duoc chot va giao dich da commit truoc khi ham nay duoc goi.
  // Chi dua yeu cau vao hang doi; tuyet doi khong cho sao luu lam cham viec chot ket qua.
  if (!competition?.competitionName || backupQueue.some(item => item.competitionName === competition.competitionName)) return;
  backupQueue.push(competition);
  void processBackupQueue();
}

async function processBackupQueue() {
  if (backupRunning) return;
  backupRunning = true;
  try {
    while (backupQueue.length) {
      const competition = backupQueue.shift();
      try {
        if (!await backupIsAvailable()) {
          console.warn('Bo qua sao luu tu dong: chua tim thay mysqldump. Cau hinh MYSQLDUMP_PATH de bat lai.');
          continue;
        }
        await createDatabaseBackup({ reason: 'after_competition_end', competitionName: competition.competitionName });
        console.info('Da sao luu database sau khi ket thuc ky thi:', competition.competitionName);
      } catch (error) {
        // Sao luu that bai chi duoc ghi log; khong duoc lam dung chuc nang thi hoac server.
        console.error('Khong the sao luu sau khi ket thuc ky thi:', error.code || error.name);
      }
    }
  } finally {
    backupRunning = false;
  }
}

function scheduleExpiryContinuation() {
  if (expiryContinuation) return;
  expiryContinuation = setTimeout(() => { expiryContinuation = undefined; checkExpired(); }, FINALIZATION_CONTINUE_DELAY);
  expiryContinuation.unref();
}

function checkExpired() {
  // Xu ly theo lo nho de luc nhieu thi sinh dong thoi nop bai, MySQL van con tai nguyen cho API.
  if (expiryRun) return;
  expiryRun = finalizeExpiredSessions(pool, { limit: FINALIZATION_BATCH_SIZE }).then(async result => {
    if (result.processed || result.failed) console.info('Cham bai het gio:', result.processed, 'thanh cong,', result.failed, 'that bai.');
    if (result.failed) console.error('Co bai het gio chua chot duoc; se thu lai o dot sau.');
    if (result.processed === FINALIZATION_BATCH_SIZE) scheduleExpiryContinuation();
    const rounds = await finalizeEndedRounds(pool, { limit: FINALIZATION_BATCH_SIZE, onCompetitionFinished: queueCompetitionBackup });
    if (rounds.finalized || rounds.waiting || rounds.failed) console.info('Chot vong thi:', rounds.finalized, 'thanh cong,', rounds.waiting, 'dang cho,', rounds.failed, 'that bai.');
    if (rounds.failed) console.error('Co vong thi chua the tu chot; se thu lai o dot sau.');
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
  clearTimeout(expiryContinuation);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (expiryRun) await expiryRun;
  await closeDatabase();
}
process.once('SIGINT', () => shutdown().catch(console.error));
process.once('SIGTERM', () => shutdown().catch(console.error));
startServer();
