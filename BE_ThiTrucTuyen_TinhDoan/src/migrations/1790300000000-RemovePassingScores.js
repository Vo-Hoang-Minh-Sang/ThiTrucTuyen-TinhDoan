// Lo?i b? ?i?m ??t c? v? ?i?m b?i thi nay l? t?ng ?i?m t?ng c?u v? vi?c ?i ti?p ch? theo Top N.
export class RemovePassingScores1790300000000 {
  name = 'RemovePassingScores1790300000000';
  transaction = false;

  async up(runner) {
    for (const [tableName, columnName] of [['competitions', 'passing_score'], ['exams', 'passingscore']]) {
      const table = await runner.getTable(tableName);
      if (table.columns.some(column => column.name === columnName)) {
        await runner.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
      }
    }
  }

  async down() {
    throw new Error('Kh?ng t? kh?i ph?c ?i?m ??t c? v? d? li?u ?? b? lo?i b?.');
  }
}
