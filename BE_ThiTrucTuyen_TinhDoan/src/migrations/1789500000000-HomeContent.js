// Lưu danh sách banner và tin tức để quản trị viên có thể thêm, ẩn hoặc xóa từng mục.
export class HomeContent1789500000000 {
  name = 'HomeContent1789500000000';
  transaction = false;
  async up(runner) {
    const table = await runner.getTable('site_settings');
    if (!table.columns.some(column => column.name === 'banners_json')) await runner.query('ALTER TABLE `site_settings` ADD COLUMN `banners_json` JSON NULL');
    if (!(await runner.getTable('site_settings')).columns.some(column => column.name === 'news_json')) await runner.query('ALTER TABLE `site_settings` ADD COLUMN `news_json` JSON NULL');
  }
  async down() { throw new Error('Không tự xóa nội dung trang chủ. Hãy khôi phục từ bản sao lưu nếu cần.'); }
}
