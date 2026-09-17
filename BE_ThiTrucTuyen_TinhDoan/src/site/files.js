import multer from 'multer';
import yauzl from 'yauzl';
import ExcelJS from 'exceljs';
import { fail } from '../common/http.js';

// Giới hạn trước khi đọc vào bộ nhớ; chỉ gắn middleware tại các API đã xác thực quyền tải lên.
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, parts: 7, fieldSize: 2048 } });
export const QUESTION_HEADERS = ['content', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'topic', 'difficulty'];
export const UNIT_HEADERS = ['Đơn vị', 'Đoàn cơ sở'];
export const CANDIDATE_ACCOUNT_HEADERS = ['Họ tên', 'Số điện thoại', 'Email', 'Đơn vị'];

// XLSX/DOCX là ZIP: đọc luồng thực để kích thước khai gian trong metadata không vượt giới hạn.
export function inspectOfficeArchive(buffer, requiredEntry) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(fail(400, 'Tệp Office bị hỏng hoặc không đúng định dạng.'));
      const maximumBytes = 30 * 1024 * 1024;
      let declaredSize = 0, actualSize = 0, count = 0, found = false, settled = false, activeStream;
      const stop = error => {
        if (settled) return;
        settled = true;
        activeStream?.destroy();
        zip.close();
        reject(error);
      };
      zip.on('error', () => stop(fail(400, 'Không thể đọc cấu trúc tệp Office.')));
      zip.on('entry', entry => {
        if (settled) return;
        declaredSize += entry.uncompressedSize; count += 1;
        if (declaredSize > maximumBytes || count > 1500 || (entry.generalPurposeBitFlag & 1) || /vbaProject\.bin$/i.test(entry.fileName)) return stop(fail(400, 'Tệp quá lớn sau giải nén, có mật khẩu hoặc chứa macro.'));
        if (entry.fileName === requiredEntry) found = true;
        // Chỉ mở mục kế tiếp sau khi mục hiện tại đọc xong, không giải nén đồng thời nhiều tệp.
        zip.openReadStream(entry, (error, stream) => {
          if (settled) { stream?.destroy(); return; }
          if (error) return stop(fail(400, 'Không thể giải nén nội dung tệp Office.'));
          activeStream = stream;
          stream.on('data', chunk => {
            actualSize += chunk.length;
            if (actualSize > maximumBytes) stop(fail(400, 'Tệp vượt giới hạn 30 MB sau giải nén.'));
          });
          stream.on('error', () => stop(fail(400, 'Nội dung hoặc kích thước giải nén của tệp Office không hợp lệ.')));
          stream.on('end', () => {
            activeStream = undefined;
            if (!settled) zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        zip.close();
        found ? resolve() : reject(fail(400, 'Tệp không đúng loại tài liệu yêu cầu.'));
      });
      zip.readEntry();
    });
  });
}

export async function readQuestionWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.originalname)) throw fail(400, 'Vui lòng chọn tệp Excel .xlsx theo mẫu.');
  await inspectOfficeArchive(file.buffer, 'xl/workbook.xml');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(file.buffer); } catch { throw fail(400, 'Không đọc được tệp Excel. Vui lòng sử dụng mẫu được cung cấp.'); }
  if (workbook.worksheets.length !== 1) throw fail(400, 'Tệp câu hỏi phải có đúng một trang tính.');
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > 501 || sheet.columnCount > 8) throw fail(400, 'Tệp chỉ được có tối đa 500 câu hỏi và 8 cột theo mẫu.');
  const cellText = cell => {
    if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink) throw fail(400, 'Tệp câu hỏi không được chứa công thức hoặc liên kết.');
    return cell.text?.trim() || '';
  };
  if (QUESTION_HEADERS.some((name, index) => cellText(sheet.getRow(1).getCell(index + 1)) !== name)) throw fail(400, 'Tên hoặc thứ tự cột không đúng mẫu.');
  const items = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const item = Object.fromEntries(QUESTION_HEADERS.map((key, index) => [key, cellText(sheet.getRow(row).getCell(index + 1))]));
    if (Object.values(item).every(value => !value)) continue;
    items.push({ ...item, row });
  }
  if (!items.length) throw fail(400, 'Tệp chưa có câu hỏi.');
  return items;
}

// Đọc mẫu đơn vị riêng, chỉ nhận hai cột tên đơn vị và đoàn cơ sở để tránh nhập nhầm dữ liệu khác.
export async function readUnitWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.originalname)) throw fail(400, 'Vui lòng chọn tệp Excel .xlsx theo mẫu.');
  await inspectOfficeArchive(file.buffer, 'xl/workbook.xml');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(file.buffer); } catch { throw fail(400, 'Không đọc được tệp Excel. Vui lòng sử dụng mẫu được cung cấp.'); }
  if (workbook.worksheets.length !== 1) throw fail(400, 'Tệp đơn vị phải có đúng một trang tính.');
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > 501 || sheet.columnCount > 2) throw fail(400, 'Tệp chỉ được có tối đa 500 đơn vị và 2 cột theo mẫu.');
  const cellText = cell => {
    if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink) throw fail(400, 'Tệp đơn vị không được chứa công thức hoặc liên kết.');
    return cell.text?.trim() || '';
  };
  if (UNIT_HEADERS.some((name, index) => cellText(sheet.getRow(1).getCell(index + 1)) !== name)) throw fail(400, 'Tên hoặc thứ tự cột không đúng mẫu đơn vị.');
  const items = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const item = { ten: cellText(sheet.getRow(row).getCell(1)), organizationName: cellText(sheet.getRow(row).getCell(2)) };
    if (Object.values(item).every(value => !value)) continue;
    if (!item.ten) throw fail(400, `Dòng ${row}: Tên đơn vị là bắt buộc.`);
    items.push({ ...item, row });
  }
  if (!items.length) throw fail(400, 'Tệp chưa có đơn vị.');
  return items;
}

// Mẫu cấp tài khoản chỉ chứa thông tin cần thiết cho vai trò thí sinh.
export async function readCandidateAccountWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.originalname)) throw fail(400, 'Vui lòng chọn tệp Excel .xlsx theo mẫu.');
  await inspectOfficeArchive(file.buffer, 'xl/workbook.xml');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(file.buffer); } catch { throw fail(400, 'Không đọc được tệp Excel. Vui lòng sử dụng mẫu được cung cấp.'); }
  if (workbook.worksheets.length !== 1) throw fail(400, 'Tệp tài khoản phải có đúng một trang tính.');
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > 501 || sheet.columnCount > 4) throw fail(400, 'Tệp chỉ được có tối đa 500 tài khoản và 4 cột theo mẫu.');
  const cellText = cell => {
    if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink) throw fail(400, 'Tệp tài khoản không được chứa công thức hoặc liên kết.');
    return cell.text?.trim() || '';
  };
  if (CANDIDATE_ACCOUNT_HEADERS.some((name, index) => cellText(sheet.getRow(1).getCell(index + 1)) !== name)) throw fail(400, 'Tên hoặc thứ tự cột không đúng mẫu tài khoản thí sinh.');
  const items = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const item = { hoten: cellText(sheet.getRow(row).getCell(1)), dienthoai: cellText(sheet.getRow(row).getCell(2)), email: cellText(sheet.getRow(row).getCell(3)), unitName: cellText(sheet.getRow(row).getCell(4)) };
    if (Object.values(item).every(value => !value)) continue;
    if (Object.values(item).some(value => !value)) throw fail(400, `Dòng ${row}: cần nhập đủ Họ tên, Số điện thoại, Email và Đơn vị.`);
    items.push({ ...item, row });
  }
  if (!items.length) throw fail(400, 'Tệp chưa có tài khoản thí sinh.');
  return items;
}

export async function sendWorkbook(res, workbook, filename) {
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
}
export function styledSheet(workbook, name, columns) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map(column => ({ width: 24, ...column }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF174C87' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return sheet;
}
