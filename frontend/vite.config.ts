import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';

const BUILD_ID = String(Date.now());

/**
 * 与服务端 `/api/version` 同源的构建身份：根 `package.json` 的版本 + `npm run build` 先写的 `.clawopt-build.json` 构建时间。
 * 前端据此判断「页面还是上一次构建的产物」（壳层的刷新提示，判据在 src/app/onboarding/onboardingState.ts）。
 * 没有构建元信息（单独跑 vite build、开发模式）时为 null，前端不提示。
 */
function readBuildIdentity(): { version: string | null; buildTime: string | null } {
  const readJson = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf-8'));
    } catch {
      return null;
    }
  };
  const version = readJson('package.json')?.version;
  const buildTime = readJson('.clawopt-build.json')?.buildTime;
  return {
    version: typeof version === 'string' ? version : null,
    buildTime: typeof buildTime === 'string' ? buildTime : null,
  };
}

export default defineConfig({
  define: {
    __CLAWOPT_BUILD_IDENTITY__: JSON.stringify(readBuildIdentity()),
  },
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
      // 实时通道（WebSocket）。开发时经 vite 代理，生产由后端同端口提供。
      '/ws': {
        target: `ws://localhost:${process.env.BACKEND_PORT || 3100}`,
        ws: true,
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