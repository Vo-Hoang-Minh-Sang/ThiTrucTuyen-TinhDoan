// Bổ sung chức năng thi và quản trị; chỉ thêm cấu trúc, không cấp quyền cho tài khoản cũ.
const stamp = 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';
const ref = (column, table, onDelete = 'RESTRICT') => ({ column, table, onDelete });
const user = (column, onDelete) => ref(column, 'users', onDelete);
const competition = column => ref(column, 'competitions');
const bigId = 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT';

export const platformUpgrades = [
  { name: 'users', columns: { role: "VARCHAR(20) NOT NULL DEFAULT 'candidate'", permissions: 'JSON NULL', must_change_password: 'TINYINT NOT NULL DEFAULT 0' } },
  { name: 'competitions', columns: { duration_minutes: 'INT UNSIGNED NOT NULL DEFAULT 30', max_attempts: 'INT UNSIGNED NOT NULL DEFAULT 1', start_at: 'DATETIME NULL', end_at: 'DATETIME NULL', status: "VARCHAR(20) NOT NULL DEFAULT 'draft'", created_by: 'INT UNSIGNED NULL' }, references: [user('created_by', 'SET NULL')] },
  { name: 'questions', columns: { competition_id: 'INT UNSIGNED NULL', topic: "VARCHAR(120) NOT NULL DEFAULT 'Chung'", difficulty: "VARCHAR(20) NOT NULL DEFAULT 'medium'", created_by: 'INT UNSIGNED NULL', archived_at: 'DATETIME NULL' }, references: [competition('competition_id'), user('created_by', 'SET NULL')] },
  { name: 'exams', columns: { code: 'VARCHAR(40) NULL', question_snapshot: 'JSON NULL', is_published: 'TINYINT NOT NULL DEFAULT 0', created_by: 'INT UNSIGNED NULL' }, references: [user('created_by', 'SET NULL')] },
  { name: 'user_exam_sessions', columns: { competition_id: 'INT UNSIGNED NULL', question_snapshot: 'JSON NULL', expires_at: 'DATETIME NULL', status: "VARCHAR(20) NOT NULL DEFAULT 'in_progress'", revision: 'INT UNSIGNED NOT NULL DEFAULT 0', attempt_number: 'INT UNSIGNED NOT NULL DEFAULT 1', updated_at: stamp }, references: [competition('competition_id')] }
];

export const platformTables = [
  { name: 'auth_sessions', primary: ['id'], columns: { id: 'VARCHAR(36) NOT NULL', user_id: 'INT UNSIGNED NOT NULL', expires_at: 'DATETIME NOT NULL', revoked_at: 'DATETIME NULL', created_at: stamp }, references: [user('user_id', 'CASCADE')] },
  { name: 'password_reset_requests', primary: ['id'], columns: { id: bigId, user_id: 'INT UNSIGNED NOT NULL', status: "VARCHAR(20) NOT NULL DEFAULT 'pending'", created_at: stamp, resolved_at: 'DATETIME NULL', resolved_by: 'INT UNSIGNED NULL' }, references: [user('user_id', 'CASCADE'), user('resolved_by', 'SET NULL')] },
  { name: 'teacher_competitions', primary: ['user_id', 'competition_id'], columns: { user_id: 'INT UNSIGNED NOT NULL', competition_id: 'INT UNSIGNED NOT NULL' }, references: [user('user_id', 'CASCADE'), competition('competition_id')] },
  { name: 'competition_registrations', primary: ['user_id', 'competition_id'], columns: { user_id: 'INT UNSIGNED NOT NULL', competition_id: 'INT UNSIGNED NOT NULL', unit_id: 'INT UNSIGNED NULL', registered_at: stamp }, references: [user('user_id'), competition('competition_id'), ref('unit_id', 'donvi', 'SET NULL')] },
  { name: 'site_settings', primary: ['id'], columns: { id: 'INT UNSIGNED NOT NULL', title: 'VARCHAR(255) NOT NULL', description: 'TEXT NULL', banner_url: 'VARCHAR(255) NULL', news_url: 'VARCHAR(255) NULL', news_title: 'VARCHAR(255) NULL', updated_at: stamp } },
  { name: 'site_assets', primary: ['id'], columns: { id: 'VARCHAR(36) NOT NULL', original_name: 'VARCHAR(255) NOT NULL', kind: 'VARCHAR(20) NOT NULL', mime_type: 'VARCHAR(100) NOT NULL', path: 'VARCHAR(255) NOT NULL', created_by: 'INT UNSIGNED NULL', created_at: stamp }, references: [user('created_by', 'SET NULL')] },
  { name: 'audit_logs', primary: ['id'], columns: { id: bigId, actor_id: 'INT UNSIGNED NULL', action: 'VARCHAR(80) NOT NULL', target_type: 'VARCHAR(50) NOT NULL', target_id: 'VARCHAR(64) NULL', created_at: stamp }, references: [user('actor_id', 'SET NULL')] }
];

const quote = name => `\`${name.replaceAll('`', '``')}\``;
const foreignClause = (name, reference) => `CONSTRAINT ${quote(`fk_platform_${name}_${reference.column}`)} FOREIGN KEY (${quote(reference.column)}) REFERENCES ${quote(reference.table)} (\`id\`) ON UPDATE CASCADE ON DELETE ${reference.onDelete}`;

async function definitionFor(runner, definition, reference) {
  if (!reference) return definition;
  // Khóa ngoại mới lấy kiểu và dấu của ID cha, tương thích các database cũ dùng INT có dấu.
  const parent = await runner.getTable(reference.table);
  const id = parent?.columns.find(column => column.name === 'id');
  if (!id || !['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint'].includes(id.type)) throw new Error(`Không tìm thấy ID số nguyên hợp lệ tại bảng ${reference.table}.`);
  return definition.replace(/^INT UNSIGNED/, `${id.type.toUpperCase()}${id.unsigned ? ' UNSIGNED' : ''}`);
}

export class ExamPlatform1789000000000 {
  name = 'ExamPlatform1789000000000';
  transaction = false;

  async up(runner) {
    for (const definition of platformUpgrades) {
      let table = await runner.getTable(definition.name);
      if (!table) throw new Error(`Cần chạy migration nền trước: thiếu bảng ${definition.name}.`);
      for (const [column, sql] of Object.entries(definition.columns)) {
        if (table.columns.some(item => item.name === column)) continue;
        const reference = definition.references?.find(item => item.column === column);
        const constraint = reference ? `, ADD ${foreignClause(definition.name, reference)}` : '';
        // Thêm cột và ràng buộc cùng DDL để có thể tiếp tục an toàn sau khi bị ngắt.
        await runner.query(`ALTER TABLE ${quote(definition.name)} ADD COLUMN ${quote(column)} ${await definitionFor(runner, sql, reference)}${constraint}`);
        table = await runner.getTable(definition.name);
      }
    }

    for (const definition of platformTables) {
      if (await runner.getTable(definition.name)) continue;
      const columns = [];
      for (const [column, sql] of Object.entries(definition.columns)) columns.push(`${quote(column)} ${await definitionFor(runner, sql, definition.references?.find(item => item.column === column))}`);
      columns.push(`PRIMARY KEY (${definition.primary.map(quote).join(', ')})`);
      for (const reference of definition.references || []) columns.push(foreignClause(definition.name, reference));
      await runner.query(`CREATE TABLE IF NOT EXISTS ${quote(definition.name)} (${columns.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    const indexes = [
      ['auth_sessions', 'idx_auth_user', ['user_id', 'revoked_at', 'expires_at']],
      ['password_reset_requests', 'idx_password_request_status', ['user_id', 'status']],
      ['questions', 'idx_questions_competition', ['competition_id', 'archived_at']],
      ['user_exam_sessions', 'idx_session_timeout', ['status', 'expires_at']],
      ['user_exam_sessions', 'idx_session_user_competition', ['user_id', 'competition_id', 'status']],
      ['competition_registrations', 'idx_registration_competition', ['competition_id', 'registered_at']],
      ['audit_logs', 'idx_audit_created', ['created_at']]
    ];
    for (const [name, indexName, columns] of indexes) {
      const table = await runner.getTable(name);
      if (!table.indices.some(index => index.name === indexName || index.columnNames.join(',') === columns.join(','))) await runner.query(`CREATE INDEX ${quote(indexName)} ON ${quote(name)} (${columns.map(quote).join(', ')})`);
    }
    // Giữ nguyên điểm và dữ liệu cũ; chỉ phản ánh trạng thái những phiên đã hoàn tất.
    await runner.query("UPDATE user_exam_sessions SET status = 'submitted' WHERE finished_at IS NOT NULL AND status = 'in_progress'");
  }

  async down() {
    throw new Error('Không tự hoàn tác migration này vì sẽ mất dữ liệu thi và phân quyền. Hãy khôi phục bản sao lưu đã chọn.');
  }
}
