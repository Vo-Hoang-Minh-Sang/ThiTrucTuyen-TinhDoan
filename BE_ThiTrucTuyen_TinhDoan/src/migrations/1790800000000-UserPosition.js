// Them chuc vu va dat mac dinh de tai khoan cu giu du lieu hop le.
export class UserPosition1790800000000 {
  name = 'UserPosition1790800000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('users');
    if (!table.columns.some(column => column.name === 'chuc_vu')) {
      await runner.query("ALTER TABLE `users` ADD COLUMN `chuc_vu` VARCHAR(100) NOT NULL DEFAULT 'Đoàn viên' AFTER `email`");
    }
  }

  async down() {
    throw new Error('Khong tu dong xoa truong chuc vu de tranh mat thong tin tai khoan.');
  }
}
