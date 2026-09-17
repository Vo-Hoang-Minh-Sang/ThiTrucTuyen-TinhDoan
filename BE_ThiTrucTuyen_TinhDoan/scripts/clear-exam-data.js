// Dọn dữ liệu nghiệp vụ để kiểm thử lại, giữ nguyên tài khoản, đơn vị, nội dung trang chủ và cấu trúc CSDL.
import { dataSource } from '../src/data-source.js';

const tables = [
  'results',
  'user_exam_sessions',
  'exam_questions',
  'exams',
  'questions',
  'competition_registrations',
  'teacher_competitions',
  'rounds',
  'competitions',
  'statistics'
];
const preservedTables = ['users', 'donvi', 'doancoso', 'auth_sessions', 'site_assets', 'site_settings'];

async function counts(query, tableNames = tables) {
  const rows = await Promise.all(tableNames.map(async table => {
    const [row] = await query(`SELECT COUNT(*) AS total FROM ${table}`);
    return [table, Number(row.total)];
  }));
  return Object.fromEntries(rows);
}

try {
  await dataSource.initialize();
  const before = await counts(sql => dataSource.query(sql));
  await dataSource.transaction(async manager => {
    // Xóa bảng con trước để luôn tôn trọng khóa ngoại.
    for (const table of tables) await manager.query(`DELETE FROM ${table}`);
    // Tránh để trang chủ giữ ID của một kỳ thi đã bị xóa.
    await manager.query('UPDATE site_settings SET pinned_competition_id=NULL WHERE pinned_competition_id IS NOT NULL');
  });
  const after = await counts(sql => dataSource.query(sql));
  const preserved = await counts(sql => dataSource.query(sql), preservedTables);
  console.log(JSON.stringify({ success: true, before, after, preserved }, null, 2));
} finally {
  if (dataSource.isInitialized) await dataSource.destroy();
}
