# OpenClaw Chat Gateway v2.2.8

- 修复“最大化权限”在 root / 系统级 OpenClaw 安装场景下无法定位 exec preflight bundle 的问题。
- 扩展 OpenClaw 运行时探测：支持更多全局安装路径与可执行入口反向定位，提升环境兼容性。
- 强化 preflight 补丁目标识别逻辑，兼容 `.js/.mjs` 产物与签名细微变化。
