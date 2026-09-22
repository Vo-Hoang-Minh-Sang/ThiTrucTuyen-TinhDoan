import { Router } from 'express';
import { createAccess, requireRoles } from '../auth/access.js';
import { createCandidateService, examError } from './exam-service.js';
import { createRateLimiter } from '../auth/security.js';

export { finalizeExpiredSessions } from './exam-service.js';

function id(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) {
    throw examError(400, 'Mã kỳ thi hoặc bài làm không hợp lệ.', 'INVALID_ID');
  }
  return value;
}

function body(request) {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw examError(400, 'Dữ liệu yêu cầu phải là đối tượng JSON.', 'INVALID_BODY');
  }
  return request.body;
}

// Lọc theo ngày địa phương; ngày cuối bao gồm trọn ngày được chọn.
function dateFilter(value, nextDay = false) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw examError(400, 'Ngày lọc phải có dạng YYYY-MM-DD.', 'INVALID_DATE');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (year < 2000 || year > 2200 || parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    throw examError(400, 'Ngày lọc không hợp lệ.', 'INVALID_DATE');
  }
  if (nextDay) parsed.setDate(parsed.getDate() + 1);
  return parsed;
}

function route(handler) {
  return async (request, response, next) => {
    try { await handler(request, response); }
    catch (error) {
      if (error.status >= 400 && error.status < 500) {
        response.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.item ? { item: error.item } : {}) });
      } else next(error);
    }
  };
}

export function createCandidateRouter({ pool, env = process.env }) {
  const router = Router();
  const limiter = createRateLimiter();
  const service = createCandidateService({ pool });
  router.use(createAccess({ pool, env }), requireRoles('candidate'));
  // Lưu đáp án được phép nhiều lần để không cản trở thao tác thi, còn mở bài và nộp bài có ngưỡng riêng.
  router.use((request, response, next) => {
    const policy = request.path.endsWith('/answers') ? { scope: 'answer-save', limit: 120, windowMs: 60 * 1000 }
      : request.path.endsWith('/submit') ? { scope: 'submit', limit: 10, windowMs: 60 * 1000 }
        : request.path.endsWith('/start') ? { scope: 'start', limit: 12, windowMs: 60 * 1000 }
          : request.path.endsWith('/register') ? { scope: 'register', limit: 5, windowMs: 60 * 60 * 1000 } : null;
    if (!policy) return next();
    const attempt = limiter.consume(policy.scope, request.user.id, policy.limit, policy.windowMs);
    if (attempt.allowed) return next();
    response.set('Retry-After', String(attempt.retryAfter));
    return response.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.', retryAfter: attempt.retryAfter });
  });
  router.get('/competitions', route(async (request, response) => {
    const from = dateFilter(request.query.from);
    const to = dateFilter(request.query.to, true);
    if (from && to && from >= to) throw examError(400, 'Ngày bắt đầu phải không lớn hơn ngày kết thúc.', 'INVALID_DATE_RANGE');
    response.json({ success: true, items: await service.competitions(request.user.id, { from, to }) });
  }));
  router.post('/competitions/:id/register', route(async (request, response) => {
    body(request);
    response.json({ success: true, item: await service.register(request.user.id, id(request.params.id)) });
  }));
  router.post('/competitions/:id/start', route(async (request, response) => {
    const data = body(request);
    response.json({ success: true, item: await service.start(request.user.id, id(request.params.id), data.roundId == null ? undefined : id(String(data.roundId))) });
  }));
  router.get('/sessions/:id', route(async (request, response) => {
    response.json({ success: true, item: await service.session(request.user.id, id(request.params.id)) });
  }));
  router.get('/sessions/:id/status', route(async (request, response) => {
    response.json({ success: true, item: await service.sessionStatus(request.user.id, id(request.params.id)) });
  }));
  router.put('/sessions/:id/answers', route(async (request, response) => {
    response.json({ success: true, item: await service.save(request.user.id, id(request.params.id), body(request)) });
  }));
  router.post('/sessions/:id/submit', route(async (request, response) => {
    response.json({ success: true, item: await service.submit(request.user.id, id(request.params.id), body(request)) });
  }));
  router.get('/results', route(async (request, response) => {
    const competitionId = request.query.competitionId === undefined || request.query.competitionId === '' ? undefined : id(request.query.competitionId);
    response.json({ success: true, items: await service.results(request.user.id, competitionId) });
  }));
  return router;
}
