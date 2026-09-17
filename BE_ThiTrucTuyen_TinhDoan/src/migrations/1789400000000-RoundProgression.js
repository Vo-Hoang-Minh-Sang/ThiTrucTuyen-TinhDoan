// Mở rộng bảng hiện có; vòng cũ chỉ trở thành vòng loại khi quản trị cấu hình và lưu lại.
export class RoundProgression1789400000000 {
  name = 'RoundProgression1789400000000';
  transaction = false;
  async up(runner) {
    const additions = {
      rounds: { name: 'VARCHAR(255) NULL', duration_minutes: 'INT UNSIGNED NOT NULL DEFAULT 30', advance_count: 'INT UNSIGNED NOT NULL DEFAULT 0', enabled: 'TINYINT NOT NULL DEFAULT 0', finalized_at: 'DATETIME NULL' },
      questions: { round_id: 'INT NULL' },
      results: { started_at: 'DATETIME NULL', duration_seconds: 'INT UNSIGNED NULL', round_rank: 'INT UNSIGNED NULL', advanced: 'TINYINT NULL' }
    };
    const roundTable = await runner.getTable('rounds');
    const parent = roundTable.columns.find(column => column.name === 'id');
    for (const [table, columns] of Object.entries(additions)) {
      for (const [column, definition] of Object.entries(columns)) {
        if ((await runner.getTable(table)).columns.some(item => item.name === column)) continue;
        const sql = table === 'questions' ? `${parent.type.toUpperCase()}${parent.unsigned ? ' UNSIGNED' : ''} NULL, ADD CONSTRAINT \`fk_questions_round\` FOREIGN KEY (\`round_id\`) REFERENCES \`rounds\` (\`id\`)` : definition;
        await runner.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${sql}`);
      }
    }
    // Chỉ khôi phục thời gian khi liên kết phiên và các mốc server cũ đều hợp lệ.
    await runner.query(`UPDATE results r JOIN user_exam_sessions s ON s.id=r.session_id AND s.user_id=r.user_id AND s.exam_id=r.exam_id
      SET r.started_at=s.started_at,r.duration_seconds=TIMESTAMPDIFF(SECOND,s.started_at,r.finished_at)
      WHERE r.started_at IS NULL AND r.finished_at>=s.started_at`);
  }
  async down() { throw new Error('Không tự xóa dữ liệu vòng thi hoặc kết quả. Hãy khôi phục từ bản sao lưu nếu cần.'); }
}
