// Tập trung cấu hình kết nối, ánh xạ entity và danh sách migration của backend.
import 'reflect-metadata';
import dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import DoanCoSo from './entities/DoanCoSo.js';
import DonVi from './entities/DonVi.js';
import User from './entities/User.js';
import Question from './entities/Question.js';
import Exam from './entities/Exam.js';
import ExamQuestion from './entities/ExamQuestion.js';
import Competition from './entities/Competition.js';
import Round from './entities/Round.js';
import UserExamSession from './entities/UserExamSession.js';
import Result from './entities/Result.js';
import Statistics from './entities/Statistics.js';
import Rank from './entities/Rank.js';
import PasswordResetTemp from './entities/PasswordResetTemp.js';
import OtpVerification from './entities/OtpVerification.js';
import { InitialSchema1788912000000 } from './migrations/1788912000000-InitialSchema.js';
import { ExamPlatform1789000000000 } from './migrations/1789000000000-ExamPlatform.js';
import AuthSession from './entities/AuthSession.js';
import PasswordResetRequest from './entities/PasswordResetRequest.js';
import TeacherCompetition from './entities/TeacherCompetition.js';
import CompetitionRegistration from './entities/CompetitionRegistration.js';
import SiteSetting from './entities/SiteSetting.js';
import SiteAsset from './entities/SiteAsset.js';
import AuditLog from './entities/AuditLog.js';

dotenv.config();

export const dataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tinhdoan_thitructuyen',
  entities: [DoanCoSo, DonVi, User, Question, Exam, ExamQuestion, Competition, Round, UserExamSession, Result, Statistics, Rank, PasswordResetTemp, OtpVerification, AuthSession, PasswordResetRequest, TeacherCompetition, CompetitionRegistration, SiteSetting, SiteAsset, AuditLog],
  migrations: [InitialSchema1788912000000, ExamPlatform1789000000000],
  migrationsTableName: 'schema_migrations',
  // MySQL tự xác nhận các lệnh DDL nên không bọc toàn bộ migration trong giao dịch.
  migrationsTransactionMode: 'none',
  synchronize: false,
  logging: false
});

// Chỉ lấy repository khi được gọi, sau khi DataSource đã khởi tạo.
export const repositories = {
  doanCoSo: () => dataSource.getRepository(DoanCoSo),
  donVi: () => dataSource.getRepository(DonVi),
  user: () => dataSource.getRepository(User),
  question: () => dataSource.getRepository(Question),
  exam: () => dataSource.getRepository(Exam),
  examQuestion: () => dataSource.getRepository(ExamQuestion),
  competition: () => dataSource.getRepository(Competition),
  round: () => dataSource.getRepository(Round),
  userExamSession: () => dataSource.getRepository(UserExamSession),
  result: () => dataSource.getRepository(Result),
  statistics: () => dataSource.getRepository(Statistics),
  rank: () => dataSource.getRepository(Rank),
  passwordResetTemp: () => dataSource.getRepository(PasswordResetTemp),
  otpVerification: () => dataSource.getRepository(OtpVerification)
};
