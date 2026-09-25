import cors from 'cors';
import express from 'express';
import { createAuthRouter } from './auth/auth.js';
import { createPublicRouter } from './exam/public.js';
import { createCandidateRouter } from './exam/candidate.js';
import { createManageRouter } from './management/manage.js';
import { createReportsRouter } from './management/reports.js';
import { createSiteRouter } from './site/assets.js';

// Chỉ tạo ứng dụng Express, không mở cổng máy chủ hay thay đổi cơ sở dữ liệu.
export function createApp({ pool, sendOtpEmail }) {
  const app = express();
  // Cấu hình số lớp proxy được tin cậy để xác định IP dùng cho giới hạn yêu cầu.
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
  if (proxyHops) app.set('trust proxy', proxyHops);
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
  app.use(express.json({ limit: '512kb' }));
  app.use((_request, response, next) => {
    response.set('X-Content-Type-Options', 'nosniff');
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use((request, response, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method) && request.is('application/json') && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))) return response.status(400).json({ success: false, message: 'Nội dung yêu cầu phải là đối tượng JSON.' });
    next();
  });
  app.use('/api/auth', createAuthRouter({ pool, sendOtpEmail }));
  app.use('/api/candidate', createCandidateRouter({ pool }));
  app.use('/api', createSiteRouter({ pool }));
  app.use('/api/manage', createManageRouter({ pool }));
  app.use('/api/reports', createReportsRouter({ pool }));
  app.use('/api', createPublicRouter({ pool }));
  // Xử lý lỗi tập trung; chỉ ghi mã hoặc tên lỗi, không trả chi tiết nội bộ cho phía giao diện.
  app.use((error, request, response, _next) => {
    if (error.type === 'entity.parse.failed') return response.status(400).json({ success: false, message: 'Nội dung JSON không hợp lệ.' });
    if (error.type === 'entity.too.large') return response.status(413).json({ success: false, message: 'Yêu cầu vượt quá dung lượng cho phép.' });
    if (error.name === 'MulterError') return response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message: 'Tệp tải lên không hợp lệ hoặc vượt giới hạn 5 MB.' });
    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) return response.status(error.status).json({ success: false, message: error.message, code: error.code, ...(error.item ? { item: error.item } : {}) });
    if (error.code === 'ER_DUP_ENTRY' || error.driverError?.code === 'ER_DUP_ENTRY') return response.status(409).json({ success: false, message: 'Thông tin đã tồn tại. Vui lòng kiểm tra số điện thoại, email hoặc dữ liệu trùng.' });
    // Chỉ ghi phương thức, đường dẫn và mã lỗi để lần theo lỗi 500 mà không ghi token hay mật khẩu vào log.
    console.error('API error:', request.method, request.originalUrl, error.code || error.name || 'UnknownError');
    return response.status(500).json({ success: false, message: 'Không thể xử lý yêu cầu. Vui lòng thử lại sau.' });
  });
  app.use((_request, response) => response.status(404).json({ success: false, message: 'Không tìm thấy tài nguyên.' }));
  return app;
}
