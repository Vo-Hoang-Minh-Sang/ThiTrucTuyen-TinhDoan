export class FooterContent1790900000000 {
  name = 'FooterContent1790900000000'; transaction = false;
  async up(runner) {
    const table = await runner.getTable('site_settings');
    if (!table.columns.some(column => column.name === 'footer_json')) await runner.query('ALTER TABLE `site_settings` ADD COLUMN `footer_json` JSON NULL');
  }
  async down() { throw new Error('Khong tu dong xoa cau hinh footer.'); }
}
