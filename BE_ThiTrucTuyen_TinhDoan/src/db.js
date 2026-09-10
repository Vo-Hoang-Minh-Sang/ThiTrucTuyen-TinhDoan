// Khởi tạo MySQL, chạy migration và tạo dữ liệu minh họa khi được bật rõ ràng.
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { dataSource, repositories } from './data-source.js';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tinhdoan_thitructuyen'
};

// Giữ dạng kết quả [rows] quen thuộc của mysql2 khi truy vấn qua TypeORM.
export const pool = {
  async query(...args) {
    const result = await dataSource.query(...args);
    return [result];
  },
  async transaction(callback) {
    // Mọi truy vấn trong callback dùng cùng giao dịch; lỗi sẽ được TypeORM hoàn tác.
    return dataSource.transaction((manager) => callback({
      async query(...args) {
        return [await manager.query(...args)];
      }
    }));
  }
};

export async function initializeDatabase({ seed = process.env.SEED_DEMO_DATA === 'true' } = {}) {
  // Chặn dữ liệu minh họa ở production kể cả khi cấu hình seed bị bật nhầm.
  if (seed && !['development', 'demo'].includes(process.env.NODE_ENV || 'development')) {
    throw new Error('SEED_DEMO_DATA is only supported in development or demo environments.');
  }
  const serverConnection = await mysql.createConnection({ host: dbConfig.host, port: dbConfig.port, user: dbConfig.user, password: dbConfig.password });
  try {
    await serverConnection.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(dbConfig.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await serverConnection.end();
  }
  try {
    if (!dataSource.isInitialized) await dataSource.initialize();
    // TypeORM ghi nhận migration đã chạy; không tự đồng bộ cấu trúc từ entity.
    await dataSource.runMigrations({ transaction: 'none' });
    if (seed) await seedDatabase();
  } catch (error) {
    await closeDatabase();
    throw error;
  }
}

async function seedDatabase() {
  // Tìm bản ghi trước khi thêm để chạy lại không nhân đôi dữ liệu minh họa.
  const doanCoSoRepository = repositories.doanCoSo();
  const donViRepository = repositories.donVi();
  const userRepository = repositories.user();
  const questionRepository = repositories.question();
  const examRepository = repositories.exam();
  const examQuestionRepository = repositories.examQuestion();
  const competitionRepository = repositories.competition();
  const roundRepository = repositories.round();

  let organization = await doanCoSoRepository.findOne({ where: { ten: 'Tỉnh Đoàn Vĩnh Long' } });
  if (!organization) organization = await doanCoSoRepository.save(doanCoSoRepository.create({ ten: 'Tỉnh Đoàn Vĩnh Long' }));

  let unit = await donViRepository.findOne({ where: { ten: 'Đoàn trường Đại học Vĩnh Long' } });
  if (!unit) unit = await donViRepository.save(donViRepository.create({ doanCoSoID: organization.id, ten: 'Đoàn trường Đại học Vĩnh Long' }));

  const examSeeds = [
    ['Tìm hiểu lịch sử Đoàn TNCS Hồ Chí Minh', 'Tìm hiểu hành trình vẻ vang của Đoàn.', 50, 15],
    ['Tuổi trẻ với chuyển đổi số', 'Kiến thức về chuyển đổi số trong thanh niên.', 50, 20],
    ['Thanh niên Vĩnh Long tự hào truyền thống', 'Tìm hiểu truyền thống quê hương Vĩnh Long.', 50, 25]
  ];
  const exams = [];
  for (const [name, description, passingscore, takingtime] of examSeeds) {
    let exam = await examRepository.findOne({ where: { name } });
    if (!exam) exam = await examRepository.save(examRepository.create({ name, description, passingscore, takingtime }));
    exams.push(exam);
  }

  const questionSeeds = [
    ['Đoàn TNCS Hồ Chí Minh được thành lập vào năm nào?', '1930', '1931', '1932', '1933', 'B'],
    ['Màu áo truyền thống của thanh niên tình nguyện là màu gì?', 'Xanh', 'Đỏ', 'Vàng', 'Trắng', 'A'],
    ['Vĩnh Long thuộc khu vực nào của Việt Nam?', 'Đông Bắc', 'Tây Nam Bộ', 'Tây Bắc', 'Bắc Trung Bộ', 'B']
  ];
  const questions = [];
  for (const [content, optionA, optionB, optionC, optionD, correctAnswer] of questionSeeds) {
    let question = await questionRepository.findOne({ where: { content } });
    if (!question) question = await questionRepository.save(questionRepository.create({ content, optionA, optionB, optionC, optionD, correctAnswer }));
    questions.push(question);
  }

  for (let index = 0; index < Math.min(exams.length, questions.length); index += 1) {
    const existingLink = await examQuestionRepository.findOne({ where: { exam_id: exams[index].id, question_id: questions[index].id } });
    if (!existingLink) await examQuestionRepository.save(examQuestionRepository.create({ exam_id: exams[index].id, question_id: questions[index].id }));
  }

  if (!(await userRepository.findOne({ where: { email: 'minhanh@example.com' } }))) {
    await userRepository.save(userRepository.create({ hoten: 'Nguyễn Minh Anh', dienthoai: '0901234567', email: 'minhanh@example.com', donviID: unit.id, password: await bcrypt.hash('123456', 10), is_active: true }));
  }

  let competition = await competitionRepository.findOne({ where: { name: 'Hội thi trực tuyến tìm hiểu truyền thống Đoàn' } });
  // Dữ liệu demo luôn bám theo ngày hiện tại để có thể kiểm thử ngay sau khi seed lại.
  const firstDay = new Date();
  firstDay.setHours(0, 0, 0, 0);
  const dateAt = (offset) => {
    const date = new Date(firstDay);
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  if (!competition) competition = await competitionRepository.save(competitionRepository.create({ name: 'Hội thi trực tuyến tìm hiểu truyền thống Đoàn', description: 'Dữ liệu minh họa cho môi trường phát triển.', start_date: dateAt(0), end_date: dateAt(27) }));
  await competitionRepository.update(competition.id, {
    start_date: dateAt(0), end_date: dateAt(27),
    status: 'published', start_at: `${dateAt(0)} 00:00:00`, end_at: `${dateAt(27)} 23:59:59`,
    duration_minutes: 30, max_attempts: 2
  });
  const roundSeeds = Array.from({ length: 4 }, (_, index) => [index + 1, `${dateAt(index * 7)} 00:00:00`, `${dateAt(index * 7 + 6)} 23:59:59`]);
  const rounds = [];
  for (const [round_number, start_datetime, end_datetime] of roundSeeds) {
    let round = await roundRepository.findOne({ where: { competition_id: competition.id, round_number } });
    if (!round) round = await roundRepository.save(roundRepository.create({ competition_id: competition.id, round_number, start_datetime, end_datetime }));
    else await roundRepository.update(round.id, { start_datetime, end_datetime });
    rounds.push(round);
  }
  for (const [index, exam] of exams.entries()) {
    const question = questions[index % questions.length];
    const snapshot = [{ id: question.id, content: question.content, optionA: question.optionA, optionB: question.optionB, optionC: question.optionC, optionD: question.optionD, correctAnswer: question.correctAnswer, topic: 'Chung', difficulty: 'medium' }];
    await examRepository.update(exam.id, { competition_id: competition.id, round_id: rounds[index].id, question_snapshot: snapshot, is_published: true });
  }
  for (const question of questions) await questionRepository.update(question.id, { competition_id: competition.id });
}

export async function closeDatabase() {
  // Cho phép gọi khi khởi tạo thất bại hoặc khi dừng ứng dụng.
  if (dataSource.isInitialized) await dataSource.destroy();
}
