import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { inspectOfficeArchive, QUESTION_HEADERS, readQuestionWorkbook } from '../src/site/files.js';

// Tạo ZIP chỉ chứa một mục để kiểm tra metadata khai sai; không cần thêm thư viện nén kiểm thử.
function zipEntry(name, content, declaredSize = content.length) {
  const filename = Buffer.from(name), compressed = deflateRawSync(content);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

test('Office preflight rejects forged small ZIP metadata before handing data to ExcelJS', async () => {
  const malformed = zipEntry('xl/workbook.xml', Buffer.alloc(31 * 1024 * 1024, 65), 1);
  assert.ok(malformed.length < 5 * 1024 * 1024);
  await assert.rejects(inspectOfficeArchive(malformed, 'xl/workbook.xml'), { status: 400 });
});

test('Office preflight checks required type, macro entries and real decompression', async () => {
  await inspectOfficeArchive(zipEntry('word/document.xml', Buffer.from('<document/>')), 'word/document.xml');
  await assert.rejects(inspectOfficeArchive(zipEntry('word/document.xml', Buffer.from('<document/>')), 'xl/workbook.xml'), { status: 400 });
  await assert.rejects(inspectOfficeArchive(zipEntry('word/vbaProject.bin', Buffer.from('macro')), 'word/vbaProject.bin'), { status: 400 });
});

async function workbookFile(rows, formula = false) {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Cau hoi');
  sheet.addRow(QUESTION_HEADERS);
  for (let index = 0; index < rows; index++) sheet.addRow([formula ? { formula: '1+1', result: 2 } : 'Một tuần có bao nhiêu ngày?', '5', '6', '7', '8', 'C', 'Chung', 'easy']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { originalname: 'cau-hoi.xlsx', size: buffer.length, buffer };
}

test('question workbook accepts its template and caps import at 500 questions', async () => {
  const valid = await readQuestionWorkbook(await workbookFile(1));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].correctAnswer, 'C');
  await assert.rejects(readQuestionWorkbook(await workbookFile(501)), { status: 400 });
  await assert.rejects(readQuestionWorkbook(await workbookFile(1, true)), { status: 400 });
});
