import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';

const option = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;
const config = () => ({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'tinhdoan_thitructuyen' });
const backupDirectory = () => path.resolve(process.env.BACKUP_DIR || fileURLToPath(new URL('../../../backups/database/', import.meta.url)));
const executable = () => process.env.MYSQLDUMP_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe' : 'mysqldump');

// Kiem tra truoc khi mo ket noi MySQL de backup thieu cong cu khong lam tang tai khi ky thi ket thuc.
export async function databaseBackupAvailable() {
  const command = executable();
  if (path.isAbsolute(command)) {
    try { await access(command); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

// Tạo bản sao nhất quán bằng mysqldump, không đưa mật khẩu vào dòng lệnh hoặc log ứng dụng.
export async function createDatabaseBackup({ reason = 'manual', competitionName = null } = {}) {
  if (!await databaseBackupAvailable()) {
    const error = new Error('MYSQLDUMP_NOT_FOUND');
    error.code = 'MYSQLDUMP_NOT_FOUND';
    throw error;
  }
  const database = config();
  const directory = backupDirectory();
  let temporary;
  try {
    const connection = await mysql.createConnection(database);
    let tables;
    try {
      const [rows] = await connection.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", [database.database]);
      tables = [];
      for (const row of rows) {
        const [[count]] = await connection.query(`SELECT COUNT(*) AS total FROM ${mysql.escapeId(row.name)}`);
        tables.push({ name: row.name, rows: Number(count.total) });
      }
    } finally { await connection.end(); }
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const name = `${database.database.replace(/[^a-zA-Z0-9_-]/g, '_')}-${stamp}`;
    const destination = path.join(directory, `${name}.sql`);
    temporary = await mkdtemp(path.join(tmpdir(), 'tinhdoan-backup-options-'));
    const optionsPath = path.join(temporary, 'client.cnf');
    await writeFile(optionsPath, `[client]\nhost=${option(database.host)}\nport=${database.port}\nuser=${option(database.user)}\npassword=${option(database.password)}\n`, { mode: 0o600 });
    const child = spawn(executable(), [`--defaults-extra-file=${optionsPath}`, '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--default-character-set=utf8mb4', '--databases', database.database], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`mysqldump failed (${code}).`))); });
    child.stderr.resume();
    await Promise.all([pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 })), completion]);
    const info = await stat(destination);
    if (!info.size) throw new Error('Backup is empty.');
    const content = await readFile(destination);
    if (!content.includes(Buffer.from('Dump completed'))) throw new Error('Backup did not complete.');
    const manifest = { createdAt: new Date().toISOString(), reason, competitionName, host: database.host, port: database.port, database: database.database, file: destination, bytes: info.size, sha256: createHash('sha256').update(content).digest('hex'), tables };
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return manifest;
  } finally {
    if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(tmpdir()) && path.basename(temporary).startsWith('tinhdoan-backup-options-')) await rm(temporary, { recursive: true, force: true });
  }
}
