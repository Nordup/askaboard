import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: process.env.MATHTUTOR_BACKEND_URL ?? 'http://127.0.0.1:8080', changeOrigin: false },
      '/health': { target: process.env.MATHTUTOR_BACKEND_URL ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
});
