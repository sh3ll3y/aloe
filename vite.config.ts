import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  plugins: [react()],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: 'node',
    globals: true,
  },
}));
