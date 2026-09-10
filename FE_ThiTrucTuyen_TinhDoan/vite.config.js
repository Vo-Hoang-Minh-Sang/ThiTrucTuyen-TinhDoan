import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Khi chạy development, chuyển các yêu cầu /api sang backend trên cổng 5000.
      '/api': 'http://localhost:5000'
    }
  }
});
