import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const BUILD_ID = String(Date.now());

export default defineConfig({
  plugins: [
    {
      name: 'inject-build-id',
      transformIndexHtml(html) { return html.replace(/%BUILD_ID%/g, BUILD_ID); },
    },react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.FRONTEND_PORT) || 3105,
    host: true,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.BACKEND_PORT || 3100}`,
        changeOrigin: true,
      },
      '/uploads': {
        target: `http://localhost:${process.env.BACKEND_PORT || 3100}`,
        changeOrigin: true,
      },
      '/openclaw': {
        target: `http://localhost:${process.env.BACKEND_PORT || 3100}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});