// B? sung ?i?m ri?ng cho t?ng c?u h?i; d? li?u c? m?c ??nh m?t ?i?m ?? gi? nguy?n kh? n?ng ch?m l?i.
export class QuestionPoints1790200000000 {
  name = 'QuestionPoints1790200000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('questions');
    if (!table.columns.some(column => column.name === 'points')) {
      await runner.query("ALTER TABLE `questions` ADD COLUMN `points` DECIMAL(10,2) NOT NULL DEFAULT 1 AFTER `difficulty`");
    }
    await runner.query('UPDATE `questions` SET `points`=1 WHERE `points` IS NULL OR `points`<=0');
  }

  async down() {
    throw new Error('Kh?ng t? x?a ?i?m c?u h?i v? c? th? l?m m?t c?u h?nh ch?m ?i?m.');
  }
}
