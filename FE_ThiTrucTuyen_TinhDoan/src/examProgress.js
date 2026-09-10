export const EXAM_CACHE_PREFIX = 'tinhdoan_exam_';
export const progressKey = (userId, sessionId) => `${EXAM_CACHE_PREFIX}${userId}_${sessionId}`;
export const activeKey = userId => `${EXAM_CACHE_PREFIX}${userId}_active`;

// Chỉ khôi phục bản chưa đồng bộ thuộc đúng phiên và đúng phiên bản máy chủ.
export function recoverProgress(session, cached) {
  if (!cached || !cached.dirty || cached.revision !== session.revision || session.status !== 'in_progress' || Number(cached.updatedAt) >= Date.parse(session.expiresAt)) return null;
  if (Date.parse(session.serverNow) >= Date.parse(session.expiresAt)) return null;
  const allowed = new Set(session.questions.map(question => String(question.id)));
  if (!cached.answers || typeof cached.answers !== 'object' || Array.isArray(cached.answers)) return null;
  if (Object.entries(cached.answers).some(([id, answer]) => !allowed.has(id) || !['A', 'B', 'C', 'D'].includes(answer))) return null;
  return { ...cached.answers };
}
export function readCache(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
export function writeCache(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
export function removeCache(key) { try { localStorage.removeItem(key); } catch { /* Vẫn cho phép tiếp tục khi trình duyệt chặn bộ nhớ. */ } }
export function clearExamCaches(storage = localStorage) {
  try { for (let index = storage.length - 1; index >= 0; index--) { const key = storage.key(index); if (key?.startsWith(EXAM_CACHE_PREFIX)) storage.removeItem(key); } } catch { /* Không chặn đăng xuất khi bộ nhớ trình duyệt không khả dụng. */ }
}
export const remainingSeconds = (expiresAt, serverOffset, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(expiresAt) - now - serverOffset) / 1000));
