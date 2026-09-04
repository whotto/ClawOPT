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
    // 把稳定的第三方库拆成独立 chunk：业务代码一改，用户只需重新下载业务那一份，
    // 而不是每次发布都把 3.4MB 整包重拉一遍（跨境 4Mbit/s 链路上是 7 秒起）。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/](katex|rehype-katex|remark-math)[\\/]/.test(id)) return 'vendor-katex';
          if (/[\\/]node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast|hast|unist|unified|vfile|property-information|space-separated-tokens|comma-separated-tokens|character-entities|decode-named-character-reference|trim-lines|zwitch|bail|trough|is-plain-obj|devlop|estree-util|style-to-|inline-style-parser|html-url-attributes|ccount|markdown-table|longest-streak|escape-string-regexp|extend)/.test(id)) return 'vendor-markdown';
          if (/[\\/]node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector)[\\/]/.test(id)) return 'vendor-i18n';
          if (/[\\/]node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'vendor-motion';
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
});