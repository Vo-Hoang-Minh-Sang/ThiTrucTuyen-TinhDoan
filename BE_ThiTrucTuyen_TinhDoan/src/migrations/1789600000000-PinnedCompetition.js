export class PinnedCompetition1789600000000 {
  name = 'PinnedCompetition1789600000000'; transaction = false;
  async up(runner) { if (!(await runner.getTable('site_settings')).columns.some(column => column.name === 'pinned_competition_id')) await runner.query('ALTER TABLE `site_settings` ADD COLUMN `pinned_competition_id` INT NULL'); }
  async down() { throw new Error('Không tự xóa cấu hình ghim kỳ thi.'); }
}
