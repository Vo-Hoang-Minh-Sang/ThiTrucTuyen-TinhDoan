// T?ng ?i?m kh?ng c?n gi?i h?n thang 100 n?n c?n ?? ch? l?u t?ng ?i?m c?a m?i c?u ??ng.
export class WidenExamScores1790400000000 {
  name = 'WidenExamScores1790400000000';
  transaction = false;

  async up(runner) {
    const columns = [
      ['user_exam_sessions', 'DECIMAL(12,2) NULL'],
      ['results', 'DECIMAL(12,2) NOT NULL DEFAULT 0']
    ];
    for (const [tableName, definition] of columns) {
      const table = await runner.getTable(tableName);
      if (table.columns.some(column => column.name === 'score')) {
        await runner.query(`ALTER TABLE \`${tableName}\` MODIFY COLUMN \`score\` ${definition}`);
      }
    }
  }

  async down() {
    throw new Error('Kh?ng t? thu h?p t?ng ?i?m v? c? th? l?m m?t d? li?u ?i?m cao.');
  }
}
