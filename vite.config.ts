import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const adminPort = Number(process.env.ZTP_ADMIN_PORT ?? 4800);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${adminPort}`, changeOrigin: false } },
  },
});
