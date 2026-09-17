import { createHash } from 'node:crypto';

// Dừng khởi tạo nếu khóa JWT, thời hạn hoặc chế độ OTP không đáp ứng cấu hình an toàn.
export function validateAuthConfiguration(env = process.env) {
  const secret = env.JWT_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32 || /development[-_ ]only|change[-_ ]?me|your[-_ ](?:jwt|secret)|replace[-_ ]|^secret/i.test(secret)) {
    throw new Error('JWT_SECRET phải là khóa riêng ngẫu nhiên ít nhất 32 byte, không dùng khóa mẫu.');
  }
  if (env.NODE_ENV === 'production' && env.OTP_DEV_MODE === 'true') {
    throw new Error('Không được bật OTP_DEV_MODE trong production.');
  }
  const otpExpiresMinutes = Number(env.OTP_EXPIRES_MINUTES || 5);
  if (!Number.isInteger(otpExpiresMinutes) || otpExpiresMinutes < 1 || otpExpiresMinutes > 30) {
    throw new Error('OTP_EXPIRES_MINUTES phải là số nguyên từ 1 đến 30.');
  }
  const expiresIn = env.JWT_EXPIRES_IN || '2h';
  if (!/^[1-9]\d*(s|m|h|d)$/.test(expiresIn)) {
    throw new Error('JWT_EXPIRES_IN phải có định dạng thời lượng, ví dụ 30m hoặc 2h.');
  }
  return { secret, expiresIn, otpExpiresMinutes, otpEnabled: env.OTP_ENABLED === 'true', developmentOtp: env.NODE_ENV !== 'production' && env.OTP_DEV_MODE === 'true' };
}

// Bộ đếm chỉ nằm trong tiến trình hiện tại, bổ sung cho thời gian chờ và số lần thử OTP trong cơ sở dữ liệu.
// Khi chạy nhiều tiến trình, cần thay bằng bộ giới hạn dùng chung có cùng giao diện này.
export function createRateLimiter({ now = Date.now, maxEntries = 10000 } = {}) {
  const buckets = new Map();
  return {
    consume(scope, identity, limit, windowMs) {
      const time = now();
      // Băm định danh để bộ đếm không giữ nguyên email hoặc số điện thoại.
      const key = `${scope}:${createHash('sha256').update(String(identity)).digest('hex')}`;
      // Dọn các khoảng đếm đã hết hạn trước khi cấp chỗ cho định danh mới.
      for (const [existingKey, bucket] of buckets) {
        if (bucket.resetAt <= time) buckets.delete(existingKey);
      }
      let bucket = buckets.get(key);
      if (!bucket) {
        // Từ chối tạm thời khi đầy bộ đếm để tránh tăng bộ nhớ không giới hạn.
        if (buckets.size >= maxEntries) return { allowed: false, retryAfter: 60 };
        bucket = { count: 0, resetAt: time + windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.count >= limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - time) / 1000)) };
      bucket.count += 1;
      return { allowed: true };
    }
  };
}
