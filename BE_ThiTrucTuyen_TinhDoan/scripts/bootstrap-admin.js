import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { dataSource } from '../src/data-source.js';

// Chỉ chạy thủ công sau khi đã sao lưu và chạy migration; không tự tạo admin lúc mở server.
async function main() {
  let quiet = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!quiet) process.stdout.write(chunk); callback(); } });
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output, terminal: true }) : null;
  async function read(name, prompt, secret = false) {
    if (process.env[name]) {
      const value = process.env[name];
      if (secret) delete process.env[name];
      return value;
    }
    if (!terminal) throw new Error(`Cần khai báo ${name} hoặc chạy trong terminal tương tác.`);
    if (secret) { process.stdout.write(prompt); quiet = true; }
    try { return await terminal.question(secret ? '' : prompt); }
    finally { if (secret) { quiet = false; process.stdout.write('\n'); } }
  }

  let account;
  try {
    account = {
      hoten: (await read('ADMIN_NAME', 'Họ tên admin: ')).trim(),
      phone: (await read('ADMIN_PHONE', 'Số điện thoại: ')).trim().replace(/[\s.-]/g, ''),
      email: (await read('ADMIN_EMAIL', 'Email: ')).trim().toLowerCase(),
      password: await read('ADMIN_PASSWORD', 'Mật khẩu (ẩn khi nhập): ', true)
    };
  } finally { terminal?.close(); }
  if (!account.hoten || account.hoten.length > 255 || !/^\+?\d{9,15}$/.test(account.phone) || account.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account.email)) throw new Error('Họ tên, số điện thoại hoặc email không hợp lệ.');
  if (account.password.length < 12 || Buffer.byteLength(account.password, 'utf8') > 72) throw new Error('Mật khẩu admin cần ít nhất 12 ký tự và không quá 72 byte UTF-8.');
  const hash = await bcrypt.hash(account.password, 12);
  account.password = undefined;

  // Không gọi initializeDatabase để lệnh tạo admin không tự áp dụng migration ngoài dự kiến.
  await dataSource.initialize();
  await dataSource.transaction(async manager => {
    const admins = await manager.query("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");
    if (admins.length) throw new Error('Đã có tài khoản admin. Hãy dùng màn hình phân quyền; lệnh này chỉ khởi tạo admin đầu tiên.');
    const duplicate = await manager.query('SELECT id FROM users WHERE dienthoai = ? OR email = ? FOR UPDATE', [account.phone, account.email]);
    if (duplicate.length) throw new Error('Email hoặc số điện thoại đã thuộc tài khoản khác. Lệnh này không tự nâng quyền tài khoản cũ.');
    const created = await manager.query("INSERT INTO users (hoten, dienthoai, email, password, is_active, role, permissions, must_change_password) VALUES (?, ?, ?, ?, 1, 'admin', ?, 1)", [account.hoten, account.phone, account.email, hash, JSON.stringify(['questions', 'exams', 'candidates', 'reports'])]);
    await manager.query("INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES (?, 'admin_bootstrapped', 'user', ?)", [created.insertId, String(created.insertId)]);
  });
  process.stdout.write('Đã tạo admin đầu tiên. Đăng nhập và đổi mật khẩu để sử dụng hệ thống.\n');
}

try { await main(); }
catch (error) {
  // Không in đối tượng lỗi database vì có thể chứa tham số truy vấn nhạy cảm.
  process.stderr.write(`${error.driverError || error.query ? 'Không tạo được admin. Kiểm tra migration, kết nối và dữ liệu trùng.' : error.message}\n`);
  process.exitCode = 1;
} finally { if (dataSource.isInitialized) await dataSource.destroy(); }
