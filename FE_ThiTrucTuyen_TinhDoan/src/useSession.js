import { useCallback, useEffect, useRef, useState } from 'react';
import { api, TOKEN_KEY } from './api.js';
import { clearExamCaches } from './examProgress.js';

// Đọc thời hạn JWT để cập nhật giao diện; việc này không xác minh tính hợp lệ của token.
// API /auth/me vẫn kiểm tra chữ ký, trạng thái tài khoản và phiên bản token khi khôi phục phiên.
export function tokenExpiresAt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

// Phản hồi của token cũ không được xóa phiên vừa đăng nhập ở tab khác.
export function clearStoredToken(storage, expectedToken) {
  const current = storage.getItem(TOKEN_KEY);
  if (current && current !== expectedToken) return current;
  if (current === expectedToken) storage.removeItem(TOKEN_KEY);
  return null;
}

// Quản lý khôi phục phiên, hết hạn, đồng bộ giữa các tab và đăng xuất.
export default function useSession() {
  const [token, setToken] = useState(() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } });
  const tokenRef = useRef(token);
  const logoutRef = useRef(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  const replaceToken = useCallback((next) => {
    // Ref cập nhật ngay để các phản hồi bất đồng bộ nhận biết token mới trước lần render tiếp theo.
    tokenRef.current = next;
    logoutRef.current = null;
    setToken(next); setUser(null); setLoading(Boolean(next));
  }, []);

  const clear = useCallback((expectedToken) => {
    if (tokenRef.current !== expectedToken) return false;
    let newerToken = null;
    try { newerToken = clearStoredToken(localStorage, expectedToken); } catch { /* Vẫn đăng xuất trong bộ nhớ nếu không truy cập được localStorage. */ }
    replaceToken(newerToken);
    if (!newerToken) clearExamCaches();
    return !newerToken;
  }, [replaceToken]);

  // Khôi phục hồ sơ từ backend và bỏ qua phản hồi thuộc token đã được thay thế.
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    const expiry = tokenExpiresAt(token);
    if (expiry !== null && expiry <= Date.now()) {
      if (clear(token)) setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }
    const controller = new AbortController();
    setLoading(true); setError('');
    const isCurrent = () => !controller.signal.aborted && tokenRef.current === token && logoutRef.current !== token;
    api('/auth/me', { token, signal: controller.signal }).then((payload) => {
      if (isCurrent()) setUser(payload.user);
    }).catch((failure) => {
      if (!isCurrent()) return;
      if (failure.status === 401) {
        if (clear(token)) setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      } else setError(failure.message);
    }).finally(() => { if (isCurrent()) setLoading(false); });
    return () => controller.abort();
  }, [token, retry, clear]);

  // Tự kết thúc phiên trên giao diện khi hết hạn, kể cả người dùng không tải lại trang.
  useEffect(() => {
    const expiry = tokenExpiresAt(token);
    if (!token || expiry === null) return;
    let timer;
    const checkExpiry = () => {
      if (tokenRef.current !== token) return;
      const remaining = expiry - Date.now();
      if (remaining <= 0) {
        if (clear(token)) setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      } else timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647));
    };
    checkExpiry();
    return () => clearTimeout(timer);
  }, [token, clear]);

  // Đồng bộ đăng nhập giữa các tab và xác minh lại quyền truy cập khi quay về trang.
  useEffect(() => {
    const sync = (event) => {
      if (event.key === TOKEN_KEY || event.key === null) {
        // Sự kiện storage đang chờ có thể chứa token cũ hơn lần đăng nhập gần nhất.
        let next = event.newValue || null;
        try { next = localStorage.getItem(TOKEN_KEY); } catch { /* Dùng dữ liệu sự kiện nếu không đọc được localStorage. */ }
        if (next !== tokenRef.current) { replaceToken(next); setError(''); }
      }
    };
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !tokenRef.current || logoutRef.current || Date.now() - lastRefresh < 1000) return;
      lastRefresh = Date.now();
      setRetry((current) => current + 1);
    };
    window.addEventListener('storage', sync);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [replaceToken]);

  function authenticate(payload) {
    try { localStorage.setItem(TOKEN_KEY, payload.token); } catch { /* Tab hiện tại vẫn dùng được phiên trong bộ nhớ nếu không lưu được token. */ }
    replaceToken(payload.token); setUser(payload.user); setError('');
  }

  async function logout() {
    // Ghi nhận đúng token cần thu hồi để phản hồi chậm không xóa phiên đăng nhập mới.
    const expectedToken = tokenRef.current;
    if (logoutRef.current || !expectedToken) return;
    logoutRef.current = expectedToken;
    setLoading(true); setError('');
    let warning = '';
    try { await api('/auth/logout', { token: expectedToken, body: {} }); }
    catch (failure) { if (failure.status !== 401) warning = 'Đã đăng xuất trên thiết bị này. Máy chủ chưa xác nhận thu hồi phiên đăng nhập hiện tại.'; }
    finally {
      if (logoutRef.current === expectedToken && tokenRef.current === expectedToken && clear(expectedToken)) {
        setError(warning); setLoading(false);
      }
    }
  }

  return { user, token, loading, error, authenticate, logout, retry: () => setRetry((current) => current + 1) };
}
