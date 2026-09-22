// Loại bỏ cột cũ không còn được backend hay giao diện sử dụng.
export class RemoveUserSortBy1790500000000 {
  name = 'RemoveUserSortBy1790500000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('users');
    if (table.columns.some((column) => column.name === 'sort_by')) {
      await runner.query('ALTER TABLE `users` DROP COLUMN `sort_by`');
    }
  }

  async down() {
    throw new Error('Kh\u00f4ng t\u1ef1 kh\u00f4i ph\u1ee5c c\u1ed9t sort_by c\u0169.');
  }
}
