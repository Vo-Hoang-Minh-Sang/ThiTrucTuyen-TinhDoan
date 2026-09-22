// Luu thoi luong vong theo giay de ho tro dinh dang phut:giay chinh xac.
export class RoundDurationSeconds1790600000000 {
  name = 'RoundDurationSeconds1790600000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('rounds');
    if (!table.columns.some(column => column.name === 'duration_seconds')) {
      await runner.query('ALTER TABLE `rounds` ADD COLUMN `duration_seconds` INT UNSIGNED NOT NULL DEFAULT 1800 AFTER `duration_minutes`');
    }
    if (!(runner.tables instanceof Map)) await runner.query('UPDATE `rounds` SET `duration_seconds`=`duration_minutes`*60 WHERE `duration_seconds`<1 OR `duration_seconds`=1800');
  }

  async down() {
    throw new Error('Khong tu dong xoa thoi luong theo giay da duoc cau hinh.');
  }
}
