import multer from 'multer';
import yauzl from 'yauzl';
import ExcelJS from 'exceljs';
import { fail } from '../common/http.js';

// Giới hạn trước khi đọc vào bộ nhớ; chỉ gắn middleware tại các API đã xác thực quyền tải lên.
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, parts: 7, fieldSize: 2048 } });
// T?p tin t?c c? th? l?n h?n b?ng t?nh nh?p li?u, nh?ng v?n gi?i h?n ?? tr?nh chi?m b? nh? m?y ch?.
export const assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 5, parts: 7, fieldSize: 2048 } });
// Tiêu đề mẫu dùng tiếng Việt; STT chỉ để dễ đối chiếu và không được lưu vào dữ liệu nghiệp vụ.
export const QUESTION_HEADERS = ['STT', '\u004e\u1ed9i dung c\u00e2u h\u1ecfi', '\u0110\u00e1p \u00e1n A', '\u0110\u00e1p \u00e1n B', '\u0110\u00e1p \u00e1n C', '\u0110\u00e1p \u00e1n D', '\u0110\u00e1p \u00e1n \u0111\u00fang', '\u0110\u1ed9 kh\u00f3', 'S\u1ed1 \u0111i\u1ec3m'];
export const UNIT_HEADERS = ['STT', '\u0110\u01a1n v\u1ecb'];
export const CANDIDATE_ACCOUNT_HEADERS = ['STT', 'Họ và tên', 'Chức vụ', 'Đơn vị', 'Số điện thoại', 'Email'];
const QUESTION_FIELDS = ['content', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'difficulty', 'points'];

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
  if (sheet.rowCount > 501 || sheet.columnCount > 9) throw fail(400, 'Tệp chỉ được có tối đa 500 câu hỏi và 8 cột theo mẫu.');
  const cellText = cell => {
    if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink) throw fail(400, 'Tệp câu hỏi không được chứa công thức hoặc liên kết.');
    return cell.text?.trim() || '';
  };
  if (QUESTION_HEADERS.some((name, index) => cellText(sheet.getRow(1).getCell(index + 1)) !== name)) throw fail(400, 'Tên hoặc thứ tự cột không đúng mẫu.');
  const items = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const item = Object.fromEntries(QUESTION_FIELDS.map((key, index) => [key, cellText(sheet.getRow(row).getCell(index + 2))]));
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
  if (sheet.rowCount > 501 || sheet.columnCount > 2) throw fail(400, 'T\u1ec7p ch\u1ec9 \u0111\u01b0\u1ee3c c\u00f3 t\u1ed1i \u0111a 500 \u0111\u01a1n v\u1ecb v\u00e0 2 c\u1ed9t theo m\u1eabu.');
  const cellText = cell => {
    if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink) throw fail(400, 'Tệp đơn vị không được chứa công thức hoặc liên kết.');
    return cell.text?.trim() || '';
  };
  if (UNIT_HEADERS.some((name, index) => cellText(sheet.getRow(1).getCell(index + 1)) !== name)) throw fail(400, 'Tên hoặc thứ tự cột không đúng mẫu đơn vị.');
  const items = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const item = { ten: cellText(sheet.getRow(row).getCell(2)) };
    if (Object.values(item).every(value => !value)) continue;
    if (!item.ten) throw fail(400, `Dòng ${row}: Tên đơn vị là bắt buộc.`);
    items.push({ ...item, row });
  }
  if (!items.length) throw fail(400, 'Tệp chưa có đơn vị.');
  return items;
}

// Đọc tệp cấp tài khoản thí sinh, chỉ nhận đúng cấu trúc để tránh gán nhầm thông tin cá nhân.
export async function readCandidateAccountWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.originalname)) throw fail(400, 'Vui lòng chọn tệp Excel .xlsx theo mẫu.');
  await inspectOfficeArchive(file.buffer, 'xl/workbook.xml');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(file.buffer); } catch { throw fail(400, 'Không đọc được tệp Excel. Vui lòng dùng mẫu được cung cấp.'); }
  if (workbook.worksheets.length !== 1) throw fail(400, 'Tệp tài khoản phải có đúng một trang tính.');
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > 501 || sheet.columnCount > 6) throw fail(400, 'Tệp chỉ được có tối đa 500 tài khoản và 6 cột theo mẫu.');
  const cellText = cell => {
    if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink) throw fail(400, 'Tệp tài khoản không được chứa công thức hoặc liên kết.');
    return cell.text?.trim() || '';
  };
  if (CANDIDATE_ACCOUNT_HEADERS.some((name, index) => cellText(sheet.getRow(1).getCell(index + 1)) !== name)) throw fail(400, 'Tên hoặc thứ tự cột không đúng mẫu tài khoản thí sinh.');
  const items = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const cells = [2, 3, 4, 5, 6].map(column => cellText(sheet.getRow(row).getCell(column)));
    if (cells.every(value => !value)) continue;
    const [hoten, chucVu, unitName, dienthoai, email] = cells;
    // Giữ STT gốc để tệp kết quả đối chiếu đúng thứ tự người quản trị đã nhập.
    items.push({ row, sequence: cellText(sheet.getRow(row).getCell(1)), hoten, chucVu, unitName, dienthoai, email });
  }
  if (!items.length) throw fail(400, 'Tệp chưa có tài khoản thí sinh.');
  return items;
}

// Mẫu cấp tài khoản chỉ chứa thông tin cần thiết cho vai trò thí sinh.

export async function sendWorkbook(res, workbook, filename) {
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  // Mẫu có thể thay đổi theo nghiệp vụ; không để trình duyệt dùng lại tệp Excel cũ trong bộ nhớ đệm.
  res.set('Cache-Control', 'no-store');
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
