import 'dotenv/config';
import { createDatabaseBackup } from '../src/common/database-backup.js';

try {
  const manifest = await createDatabaseBackup();
  console.log(JSON.stringify({ success: true, ...manifest }, null, 2));
} catch (error) {
  console.error('Sao luu database that bai:', error.code || error.message);
  process.exitCode = 1;
}