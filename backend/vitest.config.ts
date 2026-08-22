import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 这些用例大多要摸真实文件系统（路径闸门、包解析），串行更好排查
    fileParallelism: false,
  },
});
