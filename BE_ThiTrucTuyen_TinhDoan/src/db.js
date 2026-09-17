// Khởi tạo MySQL và chạy migration; không tự sinh kỳ thi, đề thi hoặc câu hỏi mẫu.
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { dataSource } from './data-source.js';

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
    return [await dataSource.query(...args)];
  },
  async transaction(callback) {
    // Mọi truy vấn trong callback dùng cùng giao dịch; lỗi sẽ được TypeORM hoàn tác.
    return dataSource.transaction(manager => callback({
      async query(...args) {
        return [await manager.query(...args)];
      }
    }));
  }
};

export async function initializeDatabase() {
  const serverConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password
  });
  try {
    await serverConnection.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(dbConfig.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await serverConnection.end();
  }
  try {
    if (!dataSource.isInitialized) await dataSource.initialize();
    // Migration là nguồn duy nhất thay đổi cấu trúc database, không đồng bộ tự động từ entity.
    await dataSource.runMigrations({ transaction: 'none' });
  } catch (error) {
    await closeDatabase();
    throw error;
  }
}

export async function closeDatabase() {
  // Cho phép gọi khi khởi tạo thất bại hoặc khi dừng ứng dụng.
  if (dataSource.isInitialized) await dataSource.destroy();
}
