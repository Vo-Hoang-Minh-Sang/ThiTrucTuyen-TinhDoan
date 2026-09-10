// MySQL tự xác nhận lệnh đổi cấu trúc (DDL), không hoàn tác cả migration như giao dịch dữ liệu.
// Kiểm tra cấu trúc trước khi bổ sung để có thể chạy lại mà không xóa bản ghi hiện có.
const stamp = 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP';
const id = 'INT UNSIGNED NOT NULL AUTO_INCREMENT';
const bigId = 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT';
const integerReference = 'INT UNSIGNED';
// Dấu nhận biết bảng do migration này tạo, kể cả từ một lần chạy bị ngắt.
const baselineMarker = 'tinhdoan-baseline-v1';
const foreign = (column, table, target = 'id', onDelete = 'RESTRICT') => ({ column, table, target, onDelete });

// Bảng được xếp theo thứ tự phụ thuộc để bảng cha tồn tại trước khi tạo khóa ngoại.
export const schemaTables = [
  { name: 'doancoso', columns: { id, ten: 'VARCHAR(255) NOT NULL', created_at: stamp }, primary: ['id'] },
  {
    name: 'donvi', primary: ['id'],
    columns: { id, doanCoSoID: `${integerReference} NOT NULL`, ten: 'VARCHAR(255) NOT NULL', total_registrations: 'INT UNSIGNED NOT NULL DEFAULT 0', total_tests: 'INT UNSIGNED NOT NULL DEFAULT 0', created_at: stamp },
    references: [foreign('doanCoSoID', 'doancoso')]
  },
  {
    name: 'users', primary: ['id'], unique: [['email'], ['dienthoai']],
    columns: { id, hoten: 'VARCHAR(255) NOT NULL', dienthoai: 'VARCHAR(30) NULL', email: 'VARCHAR(255) NULL', donviID: `${integerReference} NULL`, password: 'VARCHAR(255) NOT NULL', countLogin: 'INT UNSIGNED NOT NULL DEFAULT 0', is_active: 'TINYINT NOT NULL DEFAULT 1', sort_by: 'INT NOT NULL DEFAULT 0', token_version: 'INT UNSIGNED NOT NULL DEFAULT 0', time_register: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    references: [foreign('donviID', 'donvi', 'id', 'SET NULL')]
  },
  {
    name: 'questions', primary: ['id'],
    columns: { id, content: 'TEXT NOT NULL', optionA: 'TEXT NOT NULL', optionB: 'TEXT NOT NULL', optionC: 'TEXT NOT NULL', optionD: 'TEXT NOT NULL', correctAnswer: "ENUM('A', 'B', 'C', 'D') NOT NULL", created_at: stamp }
  },
  {
    name: 'competitions', primary: ['id'],
    columns: { id, name: 'VARCHAR(255) NOT NULL', description: 'TEXT NULL', start_date: 'DATE NOT NULL', end_date: 'DATE NOT NULL', created_at: stamp }
  },
  {
    name: 'rounds', primary: ['id'],
    columns: { id, competition_id: `${integerReference} NOT NULL`, round_number: 'INT UNSIGNED NOT NULL', start_datetime: 'DATETIME NOT NULL', end_datetime: 'DATETIME NOT NULL' },
    references: [foreign('competition_id', 'competitions')]
  },
  {
    name: 'exams', primary: ['id'],
    columns: { id, name: 'VARCHAR(255) NOT NULL', description: 'TEXT NULL', passingscore: 'DECIMAL(5,2) NOT NULL DEFAULT 50', takingtime: 'INT UNSIGNED NOT NULL DEFAULT 15', competition_id: `${integerReference} NULL`, round_id: `${integerReference} NULL`, created_at: stamp },
    references: [foreign('competition_id', 'competitions', 'id', 'SET NULL'), foreign('round_id', 'rounds', 'id', 'SET NULL')]
  },
  {
    name: 'exam_questions', primary: ['exam_id', 'question_id'],
    columns: { exam_id: `${integerReference} NOT NULL`, question_id: `${integerReference} NOT NULL` },
    references: [foreign('exam_id', 'exams', 'id', 'CASCADE'), foreign('question_id', 'questions')]
  },
  {
    name: 'user_exam_sessions', primary: ['id'],
    columns: { id: bigId, user_id: `${integerReference} NOT NULL`, exam_id: `${integerReference} NOT NULL`, round_id: `${integerReference} NULL`, question_ids: 'JSON NOT NULL', answers: 'JSON NULL', score: 'DECIMAL(5,2) NULL', started_at: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', finished_at: 'DATETIME NULL' },
    references: [foreign('user_id', 'users'), foreign('exam_id', 'exams'), foreign('round_id', 'rounds', 'id', 'SET NULL')]
  },
  {
    name: 'results', primary: ['id'], unique: [['session_id']],
    columns: { id: bigId, user_id: `${integerReference} NOT NULL`, exam_id: `${integerReference} NOT NULL`, session_id: 'BIGINT UNSIGNED NULL', score: 'DECIMAL(5,2) NOT NULL DEFAULT 0', finished_at: 'DATETIME NOT NULL' },
    references: [foreign('user_id', 'users'), foreign('exam_id', 'exams'), foreign('session_id', 'user_exam_sessions', 'id', 'SET NULL')]
  },
  {
    name: 'statistics', primary: ['id'],
    columns: { id, total_registrations: 'INT UNSIGNED NOT NULL DEFAULT 0', total_tests: 'INT UNSIGNED NOT NULL DEFAULT 0', created_at: stamp, updated_at: `${stamp} ON UPDATE CURRENT_TIMESTAMP` }
  },
  {
    name: 'rank', primary: ['id'],
    columns: { id: bigId, hoten: 'VARCHAR(255) NOT NULL', dienthoai: 'VARCHAR(30) NULL', email: 'VARCHAR(255) NULL', donviID: `${integerReference} NULL`, finishedat: 'DATETIME NULL' },
    references: [foreign('donviID', 'donvi', 'id', 'SET NULL')]
  },
  {
    name: 'password_reset_temp', primary: ['email'], unique: [['key']],
    columns: { email: 'VARCHAR(255) NOT NULL', expDate: 'DATETIME NOT NULL', key: 'VARCHAR(255) NOT NULL' },
    references: [foreign('email', 'users', 'email', 'CASCADE')]
  },
  {
    name: 'otp_verifications', primary: ['id'],
    columns: { id: bigId, user_id: `${integerReference} NOT NULL`, purpose: "ENUM('register', 'reset_password') NOT NULL", otp_hash: 'VARCHAR(255) NOT NULL', expires_at: 'DATETIME NOT NULL', attempts: 'INT UNSIGNED NOT NULL DEFAULT 0', verified_at: 'DATETIME NULL', created_at: stamp },
    references: [foreign('user_id', 'users', 'id', 'CASCADE')]
  }
];

const quote = (identifier) => `\`${identifier.replaceAll('`', '``')}\``;
const sameColumns = (actual, expected) => actual.length === expected.length && actual.every((column, index) => column === expected[index]);
const foreignClause = (tableName, reference) => `CONSTRAINT ${quote(`fk_${tableName}_${reference.column}`)} FOREIGN KEY (${quote(reference.column)}) REFERENCES ${quote(reference.table)} (${quote(reference.target)}) ON UPDATE CASCADE ON DELETE ${reference.onDelete}`;

// Cột tham chiếu mới lấy đúng kiểu số nguyên của khóa cha đang có trong database.
// Không đổi ID có dấu hoặc khóa ngoại cũ chỉ để khớp khai báo entity mới.
function referenceType(table, target = 'id') {
  const column = table?.columns.find((item) => item.name === target);
  if (!column || !['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint'].includes(column.type)) return null;
  return `${column.type.toUpperCase()}${column.unsigned ? ' UNSIGNED' : ''}`;
}

function sqlColumn(definition, reference, tables) {
  const type = reference && referenceType(tables.get(reference.table), reference.target);
  return type ? definition.replace(/^(?:BIGINT|INT) UNSIGNED/, type) : definition;
}

async function ensureUnique(queryRunner, tableName, columns, checkOnly = false) {
  // Phát hiện giá trị trùng trước khi tạo chỉ mục; không tự gộp hoặc xóa dữ liệu cũ.
  const table = await queryRunner.getTable(tableName);
  if (table.uniques.some((key) => sameColumns(key.columnNames, columns)) || table.indices.some((key) => key.isUnique && sameColumns(key.columnNames, columns))) return;
  const names = columns.map(quote).join(', ');
  const nonNull = columns.map((column) => `${quote(column)} IS NOT NULL`).join(' AND ');
  const duplicates = await queryRunner.query(`SELECT 1 FROM ${quote(tableName)} WHERE ${nonNull} GROUP BY ${names} HAVING COUNT(*) > 1 LIMIT 1`);
  if (duplicates.length) {
    throw new Error(`Cannot add unique index to ${tableName}(${columns.join(', ')}): duplicate values exist. Resolve duplicates explicitly, then run db:migrate again. No records were removed.`);
  }
  if (checkOnly) return;
  await queryRunner.query(`CREATE UNIQUE INDEX ${quote(`uq_${tableName}_${columns.join('_')}`)} ON ${quote(tableName)} (${names})`);
}

export class InitialSchema1788912000000 {
  name = 'InitialSchema1788912000000';
  transaction = false;

  async up(queryRunner) {
    // Phát hiện xung đột dữ liệu cũ đã biết trước khi đổi bất kỳ cấu trúc nào.
    if (await queryRunner.getTable('users')) {
      await ensureUnique(queryRunner, 'users', ['email'], true);
      await ensureUnique(queryRunner, 'users', ['dienthoai'], true);
    }
    const existingResults = await queryRunner.getTable('results');
    if (existingResults?.columns.some((column) => column.name === 'session_id')) {
      await ensureUnique(queryRunner, 'results', ['session_id'], true);
    }
    const tables = new Map();
    const newTables = new Set();
    for (const definition of schemaTables) {
      let table = await queryRunner.getTable(definition.name);
      if (!table) {
        const columns = Object.entries(definition.columns).map(([name, sql]) => `${quote(name)} ${sqlColumn(sql, definition.references?.find((reference) => reference.column === name), tables)}`);
        columns.push(`PRIMARY KEY (${definition.primary.map(quote).join(', ')})`);
        for (const unique of definition.unique || []) columns.push(`UNIQUE KEY ${quote(`uq_${definition.name}_${unique.join('_')}`)} (${unique.map(quote).join(', ')})`);
        for (const reference of definition.references || []) {
          if (reference.target !== 'id' && !newTables.has(reference.table) && tables.get(reference.table)?.comment !== baselineMarker) continue; // Tránh ép collation email cũ; nhận diện bảng từ lần chạy bị ngắt.
          columns.push(foreignClause(definition.name, reference));
        }
        // Tạo cột và khóa ngoại trong cùng một lệnh DDL nguyên tử của MySQL.
        // Nếu tiến trình dừng ngay sau đó, lần chạy lại vẫn thấy bảng đủ ràng buộc.
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS ${quote(definition.name)} (${columns.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='${baselineMarker}'`);
        newTables.add(definition.name);
        table = await queryRunner.getTable(definition.name);
      }
      tables.set(definition.name, table);
    }

    // Danh sách cột cần bổ sung cho bảng cũ; kiểm tra tồn tại trước từng lệnh.
    const upgrades = [
      ['users', 'token_version'],
      ['exams', 'competition_id'],
      ['exams', 'round_id'],
      ['user_exam_sessions', 'round_id'],
      ['results', 'session_id']
    ];
    for (const [name, column] of upgrades) {
      if (tables.get(name).columns.some((item) => item.name === column)) continue;
      const definition = schemaTables.find((item) => item.name === name);
      const reference = definition.references?.find((item) => item.column === column);
      // Thêm cột và khóa ngoại cùng lệnh để tránh cột tồn tại nhưng thiếu ràng buộc khi chạy lại.
      const constraint = reference ? `, ADD ${foreignClause(name, reference)}` : '';
      await queryRunner.query(`ALTER TABLE ${quote(name)} ADD COLUMN ${quote(column)} ${sqlColumn(definition.columns[column], reference, tables)}${constraint}`);
    }

    const email = tables.get('users').columns.find((column) => column.name === 'email');
    if (email && !email.isNullable) {
      // Chỉ nới điều kiện cho phép NULL, giữ kiểu và độ dài email hiện có.
      if (!['varchar', 'char'].includes(email.type)) throw new Error('users.email must be a CHAR/VARCHAR column before running this migration.');
      const length = Number(email.length || 255);
      if (!Number.isInteger(length) || length < 1) throw new Error('Invalid users.email column length.');
      await queryRunner.query(`ALTER TABLE users MODIFY COLUMN email ${email.type.toUpperCase()}(${length}) NULL`);
    }
    await ensureUnique(queryRunner, 'users', ['email']);
    await ensureUnique(queryRunner, 'users', ['dienthoai']);
    await ensureUnique(queryRunner, 'results', ['session_id']);

    const otpTable = await queryRunner.getTable('otp_verifications');
    if (!otpTable.indices.some((index) => sameColumns(index.columnNames, ['user_id', 'purpose', 'expires_at']))) {
      await queryRunner.query('CREATE INDEX idx_otp_lookup ON otp_verifications (user_id, purpose, expires_at)');
    }
  }

  async down() {
    // Migration nền không tự xóa bảng khi quay lại phiên bản vì sẽ làm mất dữ liệu.
    throw new Error('This baseline migration cannot be reverted automatically because that would delete application data. Restore an explicitly selected backup instead.');
  }
}
