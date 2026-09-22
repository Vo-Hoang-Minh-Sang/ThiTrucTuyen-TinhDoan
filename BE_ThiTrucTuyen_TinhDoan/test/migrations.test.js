import { RoundProgression1789400000000 } from '../src/migrations/1789400000000-RoundProgression.js';
import { HomeContent1789500000000 } from '../src/migrations/1789500000000-HomeContent.js';
import { PinnedCompetition1789600000000 } from '../src/migrations/1789600000000-PinnedCompetition.js';
import { BonusPrediction1789700000000 } from '../src/migrations/1789700000000-BonusPrediction.js';
import { QuestionRoundScope1789800000000 } from '../src/migrations/1789800000000-QuestionRoundScope.js';
import { CompetitionPassingScore1789900000000 } from '../src/migrations/1789900000000-CompetitionPassingScore.js';
import { RemoveBonusPrediction1790000000000 } from '../src/migrations/1790000000000-RemoveBonusPrediction.js';
import { RemoveQuestionTopic1790100000000 } from '../src/migrations/1790100000000-RemoveQuestionTopic.js';
import { QuestionPoints1790200000000 } from '../src/migrations/1790200000000-QuestionPoints.js';
import { RemovePassingScores1790300000000 } from '../src/migrations/1790300000000-RemovePassingScores.js';
import { WidenExamScores1790400000000 } from '../src/migrations/1790400000000-WidenExamScores.js';
import { RemoveUserSortBy1790500000000 } from '../src/migrations/1790500000000-RemoveUserSortBy.js';
import { RoundDurationSeconds1790600000000 } from '../src/migrations/1790600000000-RoundDurationSeconds.js';
import { AuditLogDetails1790700000000 } from '../src/migrations/1790700000000-AuditLogDetails.js';
import { UserPosition1790800000000 } from '../src/migrations/1790800000000-UserPosition.js';
// Kiểm thử cấu trúc và khả năng chạy lại migration mà không cần MySQL thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import { InitialSchema1788912000000 } from '../src/migrations/1788912000000-InitialSchema.js';
import { ExamPlatform1789000000000 } from '../src/migrations/1789000000000-ExamPlatform.js';
import { CompetitionPause1789100000000 } from '../src/migrations/1789100000000-CompetitionPause.js';

function splitDefinitions(sql) {
  // Không tách dấu phẩy bên trong ENUM, chuỗi hoặc khai báo kiểu như DECIMAL(5,2).
  const items = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") quoted = !quoted;
    if (quoted) continue;
    if (sql[index] === '(') depth += 1;
    if (sql[index] === ')') depth -= 1;
    if (sql[index] === ',' && depth === 0) {
      items.push(sql.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(sql.slice(start).trim());
  return items;
}

const namesIn = (sql) => [...sql.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
function columnFrom(name, sql) {
  const [, type, size] = sql.match(/^(\w+)(?:\(([^)]*)\))?/);
  return { name, type: type.toLowerCase(), length: ['VARCHAR', 'CHAR'].includes(type) ? size : '', unsigned: /\bUNSIGNED\b/.test(sql), isNullable: !/\bNOT NULL\b/.test(sql) };
}

// Bộ giả lập đọc DDL được sinh ra, kiểm tra kiểu khóa ngoại và mô phỏng việc đọc cấu trúc cũ.
// Không mở kết nối mạng; kiểm thử MySQL thật nằm ở tệp tích hợp riêng.
class SchemaRunner {
  tables = new Map();
  queries = [];
  duplicates = new Set();
  async getTable(name) { return structuredClone(this.tables.get(name)); }
  addForeignKey(source, sql) {
    const match = sql.match(/FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\)/);
    assert.ok(match, 'valid foreign key DDL');
    const sourceColumn = source.columns.find((column) => column.name === match[1]);
    const targetColumn = this.tables.get(match[2]).columns.find((column) => column.name === match[3]);
    assert.equal(sourceColumn.type, targetColumn.type, `${source.name}.${match[1]} type`);
    assert.equal(sourceColumn.unsigned, targetColumn.unsigned, `${source.name}.${match[1]} unsigned`);
    source.foreignKeys.push({ columnNames: [match[1]] });
  }
  async query(sql) {
    this.queries.push(sql);
    // Dữ liệu mốc thời gian được kiểm tra trên MySQL thật; bộ này chỉ mô phỏng cấu trúc bảng.
    if (sql.startsWith('UPDATE results r JOIN user_exam_sessions')) return [];
    let match;
    if ((match = sql.match(/^CREATE TABLE IF NOT EXISTS `([^`]+)` \((.*)\) ENGINE=/))) {
      const table = { name: match[1], columns: [], uniques: [], indices: [], foreignKeys: [], comment: sql.match(/COMMENT='([^']+)'/)?.[1] };
      const foreignKeys = [];
      for (const definition of splitDefinitions(match[2])) {
        if (definition.startsWith('PRIMARY KEY')) continue;
        if (definition.startsWith('UNIQUE KEY')) {
          table.uniques.push({ columnNames: namesIn(definition).slice(1) });
        } else if (definition.startsWith('CONSTRAINT')) {
          foreignKeys.push(definition);
        } else {
          const [, name, type] = definition.match(/^`([^`]+)` (.*)$/);
          table.columns.push(columnFrom(name, type));
        }
      }
      if (!this.tables.has(table.name)) this.tables.set(table.name, table);
      for (const definition of foreignKeys) this.addForeignKey(table, definition);
    } else if ((match = sql.match(/^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` (.*)$/))) {
      const [column, constraint] = splitDefinitions(match[3]);
      const table = this.tables.get(match[1]);
      table.columns.push(columnFrom(match[2], column));
      if (constraint) this.addForeignKey(table, constraint);
    } else if ((match = sql.match(/^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/))) {
      const table = this.tables.get(match[1]);
      table.columns = table.columns.filter(column => column.name !== match[2]);
    } else if ((match = sql.match(/^ALTER TABLE `?([^` ]+)`? MODIFY COLUMN `?([^` ]+)`? (.*)$/))) {
      const columns = this.tables.get(match[1]).columns;
      columns[columns.findIndex((column) => column.name === match[2])] = columnFrom(match[2], match[3]);
    } else if ((match = sql.match(/^CREATE UNIQUE INDEX `[^`]+` ON `([^`]+)` \((.*)\)$/))) {
      this.tables.get(match[1]).uniques.push({ columnNames: namesIn(match[2]) });
    } else if ((match = sql.match(/^SELECT 1 FROM `([^`]+)`.*GROUP BY (.*) HAVING/))) {
      return this.duplicates.has(`${match[1]}.${namesIn(match[2]).join('.')}`) ? [{ 1: 1 }] : [];
    } else if ((match = sql.match(/^ALTER TABLE `([^`]+)` ADD CONSTRAINT `[^`]+` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\)/))) {
      this.addForeignKey(this.tables.get(match[1]), sql);
    } else if (sql === 'CREATE INDEX idx_otp_lookup ON otp_verifications (user_id, purpose, expires_at)') {
      this.tables.get('otp_verifications').indices.push({ columnNames: ['user_id', 'purpose', 'expires_at'] });
    } else if ((match = sql.match(/^CREATE INDEX `([^`]+)` ON `([^`]+)` \((.*)\)$/))) {
      this.tables.get(match[2]).indices.push({ name: match[1], columnNames: namesIn(match[3]) });
    } else if (sql.startsWith('SELECT DISTINCT competition_id FROM questions') || sql.startsWith('UPDATE questions SET round_id=') || sql.startsWith('UPDATE `questions` SET `points`=')) {
      // Migration dữ liệu chỉ có ý nghĩa trên MySQL thật; schema giả không chứa bản ghi cần chuyển đổi.
      return [];
    } else if (sql === "UPDATE user_exam_sessions SET status = 'submitted' WHERE finished_at IS NOT NULL AND status = 'in_progress'") {
      return [];
    } else {
      throw new Error(`Unexpected DDL: ${sql}`);
    }
    return [];
  }
}

async function freshSchema() {
  const runner = new SchemaRunner();
  await new InitialSchema1788912000000().up(runner);
  return runner;
}

test('all migrations create 21 entity tables and compatible foreign keys', async () => {
  const runner = await freshSchema();
  await new ExamPlatform1789000000000().up(runner);
  await new CompetitionPause1789100000000().up(runner);
  await new RoundProgression1789400000000().up(runner);
  await new HomeContent1789500000000().up(runner);
  await new PinnedCompetition1789600000000().up(runner);
  await new BonusPrediction1789700000000().up(runner);
  await new QuestionRoundScope1789800000000().up(runner);
  await new CompetitionPassingScore1789900000000().up(runner);
  await new RemoveBonusPrediction1790000000000().up(runner);
  await new RemoveQuestionTopic1790100000000().up(runner);
  await new QuestionPoints1790200000000().up(runner);
  await new RemovePassingScores1790300000000().up(runner);
  await new WidenExamScores1790400000000().up(runner);
  await new RemoveUserSortBy1790500000000().up(runner);
  await new RoundDurationSeconds1790600000000().up(runner);
  await new AuditLogDetails1790700000000().up(runner);
  await new UserPosition1790800000000().up(runner);
  const directory = new URL('../src/entities/', import.meta.url);
  const entities = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.js')).map(async (name) => (await import(new URL(name, directory))).default));
  const source = new DataSource({ type: 'mysql', database: 'offline_schema_test', entities });
  await source.buildMetadatas();
  assert.equal(source.entityMetadatas.length, 21);
  assert.equal(runner.tables.size, 21);
  for (const metadata of source.entityMetadatas) {
    const table = runner.tables.get(metadata.tableName);
    assert.ok(table, metadata.tableName);
    assert.deepEqual(table.columns.map((column) => column.name).sort(), metadata.columns.map((column) => column.databaseName).sort(), `${metadata.tableName} columns`);
    for (const column of metadata.columns) {
      const actual = table.columns.find((item) => item.name === column.databaseName);
      assert.equal(actual.unsigned, Boolean(column.unsigned), `${metadata.tableName}.${column.databaseName} unsigned`);
    }
  }
  assert.ok(runner.tables.get('results').uniques.some((index) => index.columnNames.includes('session_id')));
  assert.ok(runner.tables.get('users').uniques.some((index) => index.columnNames.includes('dienthoai')));
  assert.ok(!runner.tables.get('users').columns.some((column) => column.name === 'sort_by'));
});

test('running the baseline against an already upgraded schema makes no changes', async () => {
  const runner = await freshSchema();
  runner.queries = [];
  await new InitialSchema1788912000000().up(runner);
  assert.deepEqual(runner.queries, []);
});

test('legacy schema upgrades preserve signed IDs and email length', async () => {
  const runner = await freshSchema();
  for (const table of runner.tables.values()) {
    for (const column of table.columns) {
      if (column.type === 'int' || column.type === 'bigint') column.unsigned = false;
    }
  }
  for (const [tableName, columnName] of [['users', 'token_version'], ['exams', 'competition_id'], ['exams', 'round_id'], ['user_exam_sessions', 'round_id'], ['results', 'session_id']]) {
    const table = runner.tables.get(tableName);
    table.columns = table.columns.filter((column) => column.name !== columnName);
    table.foreignKeys = table.foreignKeys.filter((key) => !key.columnNames.includes(columnName));
    table.uniques = table.uniques.filter((key) => !key.columnNames.includes(columnName));
  }
  const email = runner.tables.get('users').columns.find((column) => column.name === 'email');
  email.isNullable = false;
  email.length = '320';
  runner.tables.delete('otp_verifications');
  runner.queries = [];
  await new InitialSchema1788912000000().up(runner);
  assert.equal(runner.tables.get('users').columns.find((column) => column.name === 'id').unsigned, false);
  assert.equal(runner.tables.get('otp_verifications').columns.find((column) => column.name === 'user_id').unsigned, false);
  assert.equal(runner.tables.get('results').columns.find((column) => column.name === 'session_id').unsigned, false);
  assert.equal(runner.tables.get('users').columns.find((column) => column.name === 'email').length, '320');
  assert.ok(!runner.queries.some((sql) => /\b(DROP|DELETE|TRUNCATE)\b/.test(sql.replaceAll('ON DELETE', 'ON REMOVE'))));
});

test('duplicate legacy phone values stop uniqueness upgrade without removing data', async () => {
  const runner = await freshSchema();
  const users = runner.tables.get('users');
  users.uniques = users.uniques.filter((key) => !key.columnNames.includes('dienthoai'));
  runner.tables.delete('otp_verifications');
  runner.duplicates.add('users.dienthoai');
  runner.queries = [];
  await assert.rejects(new InitialSchema1788912000000().up(runner), /users\(dienthoai\).*duplicate values.*No records were removed/);
  assert.ok(!runner.queries.some((sql) => /CREATE UNIQUE|DELETE FROM|DROP TABLE|TRUNCATE/.test(sql)));
  assert.equal(runner.tables.has('otp_verifications'), false, 'conflict is caught before any DDL');
});

test('baseline refuses a destructive automatic rollback', async () => {
  await assert.rejects(new InitialSchema1788912000000().down(), /cannot be reverted automatically/);
});

test('retry after a process interruption preserves inline FKs on newly created tables', async () => {
  // Cho DDL hoàn tất rồi mới báo lỗi để mô phỏng tiến trình bị ngắt sau khi MySQL đã ghi nhận.
  const runner = new SchemaRunner();
  const execute = runner.query.bind(runner);
  let interrupted = false;
  runner.query = async (sql) => {
    const result = await execute(sql);
    if (!interrupted && sql.startsWith('CREATE TABLE IF NOT EXISTS `exams`')) {
      interrupted = true;
      throw new Error('simulated interruption after successful DDL');
    }
    return result;
  };
  await assert.rejects(new InitialSchema1788912000000().up(runner), /simulated interruption/);
  await new InitialSchema1788912000000().up(runner);
  assert.equal(runner.tables.size, 14);
  assert.deepEqual(runner.tables.get('exams').foreignKeys.map((key) => key.columnNames[0]).sort(), ['competition_id', 'round_id']);
  assert.ok(runner.tables.get('password_reset_temp').foreignKeys.some((key) => key.columnNames.includes('email')), 'resumed parent tables retain compatible string references');
});

test('retry after a legacy column upgrade preserves its FK in the same ALTER', async () => {
  // Mô phỏng bảng cũ thiếu một cột, rồi kiểm tra khóa ngoại vẫn đủ khi nâng cấp bị ngắt.
  const runner = await freshSchema();
  const exams = runner.tables.get('exams');
  exams.columns = exams.columns.filter((column) => column.name !== 'round_id');
  exams.foreignKeys = exams.foreignKeys.filter((key) => !key.columnNames.includes('round_id'));
  const execute = runner.query.bind(runner);
  let interrupted = false;
  runner.query = async (sql) => {
    const result = await execute(sql);
    if (!interrupted && sql.startsWith('ALTER TABLE `exams` ADD COLUMN `round_id`')) {
      interrupted = true;
      throw new Error('simulated interruption after successful DDL');
    }
    return result;
  };
  await assert.rejects(new InitialSchema1788912000000().up(runner), /simulated interruption/);
  await new InitialSchema1788912000000().up(runner);
  assert.ok(runner.tables.get('exams').foreignKeys.some((key) => key.columnNames.includes('round_id')));
});

test('platform upgrades preserve signed legacy references and never promote or activate users', async () => {
  const runner = await freshSchema();
  for (const table of runner.tables.values()) {
    for (const column of table.columns) if (['int', 'bigint'].includes(column.type)) column.unsigned = false;
  }
  runner.queries = [];
  await new ExamPlatform1789000000000().up(runner);
  for (const [name, column] of [['auth_sessions', 'user_id'], ['teacher_competitions', 'competition_id'], ['questions', 'created_by'], ['competition_registrations', 'unit_id']]) assert.equal(runner.tables.get(name).columns.find(item => item.name === column).unsigned, false);
  assert.ok(!runner.queries.some(sql => /UPDATE users|DELETE FROM|DROP TABLE|TRUNCATE/.test(sql)));
  runner.queries = [];
  await new ExamPlatform1789000000000().up(runner);
  assert.ok(!runner.queries.some(sql => /CREATE|ALTER/.test(sql)), 'repeat migration makes no schema changes');
  await assert.rejects(new ExamPlatform1789000000000().down(), /Không tự hoàn tác/);
});

test('platform resumes after interruption with complete column and table foreign keys', async () => {
  const runner = await freshSchema();
  const execute = runner.query.bind(runner);
  let interrupted = false;
  runner.query = async sql => {
    const result = await execute(sql);
    if (!interrupted && sql.startsWith('ALTER TABLE `questions` ADD COLUMN `competition_id`')) {
      interrupted = true;
      throw new Error('platform interrupted');
    }
    return result;
  };
  await assert.rejects(new ExamPlatform1789000000000().up(runner), /platform interrupted/);
  await new ExamPlatform1789000000000().up(runner);
  assert.ok(runner.tables.get('questions').foreignKeys.some(key => key.columnNames.includes('competition_id')));
  assert.ok(runner.tables.get('auth_sessions').foreignKeys.some(key => key.columnNames.includes('user_id')));
  assert.ok(runner.tables.get('user_exam_sessions').indices.some(index => index.columnNames.join(',') === 'status,expires_at'));
});
