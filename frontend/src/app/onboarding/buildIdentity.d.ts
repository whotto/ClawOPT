/// <reference types="vite/client" />
// vite.config.ts 的 `define` 注入：前端产物构建时的版本号与构建时间（没有构建元信息时字段为 null）。
declare const __CLAWOPT_BUILD_IDENTITY__: { version: string | null; buildTime: string | null } | undefined;
