// Tiện ích giao tiếp tập trung với backend: token, timeout, lỗi API, tệp tải xuống và URL tài sản.
// Để trống địa chỉ gốc khi frontend và API dùng chung tên miền hoặc proxy của Vite.
const baseUrl = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/$/, '');
export const TOKEN_KEY = 'auth_token';

// Chỉ ghép base URL cho tài sản do API cung cấp; URL ngoài vẫn được giữ nguyên.
export const assetUrl = path => path?.startsWith('/api/') ? `${baseUrl}${path}` : path || '';

// Tạo lỗi có mã HTTP để màn hình đăng nhập và quản lý phiên vẫn nhận biết được lỗi xác thực.
function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function api(path, { token, body, signal, download = false, method = body === undefined ? 'GET' : 'POST' } = {}) {
  // Hủy yêu cầu khi nơi gọi yêu cầu dừng hoặc khi vượt thời gian chờ 30 giây.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30000);
  try {
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    const response = await fetch(`${baseUrl}/api${path}`, {
      method, signal: controller.signal,
      headers: { ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) })
    });
    if (download && response.ok) return await response.blob();
    let payload;
    if (typeof response.text === 'function') {
      // Đọc văn bản trước để phân biệt API trả JSON với trang HTML do Live Server, proxy hoặc máy chủ web trả về.
      const raw = await response.text();
      try { payload = JSON.parse(raw); } catch {
        const endpoint = `${baseUrl}/api${path}`;
        const detail = response.status === 404
          ? `Không tìm thấy API tại ${endpoint}. Hãy chạy backend hoặc cấu hình địa chỉ API.`
          : `API tại ${endpoint} phản hồi không đúng định dạng (HTTP ${response.status}). Hãy kiểm tra backend và cấu hình proxy.`;
        throw apiError(detail, response.status);
      }
    } else {
      // Bản mô phỏng Response trong test cũ chỉ có json(), nên giữ cách đọc này để test phản ánh đúng API.
      try { payload = await response.json(); } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw apiError('Máy chủ trả về dữ liệu không hợp lệ.', response.status);
      }
    }
    if (!response.ok || payload.success === false) {
      // Giữ dữ liệu lỗi để nhận biết phiên hết hạn hoặc xung đột tiến trình làm bài.
      const error = new Error(payload.message || 'Không thể xử lý yêu cầu.');
      Object.assign(error, { status: response.status, payload });
      throw error;
    }
    return payload;
  } catch (error) {
    // Phân biệt yêu cầu bị hủy chủ động với yêu cầu hết thời gian chờ.
    if (error.name === 'AbortError' && !signal?.aborted) throw new Error('Yêu cầu quá thời gian chờ. Vui lòng thử lại.');
    if (error instanceof TypeError) throw new Error('Không thể kết nối máy chủ. Vui lòng thử lại.');
    throw error;
  } finally {
    // Dọn bộ hẹn giờ và sự kiện dù yêu cầu thành công, thất bại hay bị hủy.
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function downloadFile(path, token, filename) {
  // Tạo URL tạm trong trình duyệt để tải Blob mà không phải mở tab mới.
  const blob = await api(path, { token, download: true });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
