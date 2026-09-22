import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Khi chạy development, chuyển các yêu cầu /api sang backend trên cổng 5000.
      // Nếu backend đang khởi động lại, phản hồi JSON để frontend không nhận trang lỗi HTML.
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
        timeout: 30_000,
        proxyTimeout: 30_000,
        configure(proxy) {
          proxy.on('error', (_error, _request, response) => {
            if (response.headersSent) return;
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: false, message: 'Backend đang khởi động hoặc không thể kết nối.' }));
          });
        }
      }
    }
  }
});
