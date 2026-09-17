// Các lỗi nghiệp vụ được trả về có kiểm soát, không làm lộ lỗi truy vấn hoặc cấu hình.
export function fail(status, message, code = 'VALIDATION_ERROR') {
  return Object.assign(new Error(message), { status, code });
}
export const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
export function positiveId(value, label = 'Mã dữ liệu') {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw fail(400, `${label} không hợp lệ.`);
  return Number(value);
}
export function textField(value, label, max = 255, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(400, `${label} cần từ 1 đến ${max} ký tự.`);
  return value.trim();
}
export function integer(value, label, min, max) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw fail(400, `${label} phải là số nguyên từ ${min} đến ${max}.`);
  return Number(value);
}
export function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
export const iso = value => value ? new Date(value).toISOString() : null;
export async function audit(db, actorId, action, targetType, targetId) {
  await db.query('INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES (?, ?, ?, ?)', [actorId, action, targetType, targetId == null ? null : String(targetId)]);
}
export function requirePermission(user, permission) {
  if (user.role !== 'admin' && (user.role !== 'teacher' || !user.permissions?.includes(permission))) throw fail(403, 'Bạn không có quyền thực hiện chức năng này.', 'FORBIDDEN');
}
export function dateFilters(query) {
  const dates = {};
  for (const key of ['from', 'to']) {
    if (!query[key]) continue;
    const parsed = new Date(`${query[key]}T00:00:00Z`);
    if (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== query[key]) throw fail(400, 'Ngày lọc phải hợp lệ và có dạng YYYY-MM-DD.');
    dates[key] = query[key];
  }
  if (dates.from && dates.to && dates.from > dates.to) throw fail(400, 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
  return dates;
}
