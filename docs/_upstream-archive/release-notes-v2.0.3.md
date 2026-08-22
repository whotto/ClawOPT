# OpenClaw Chat Gateway v2.0.3

## 重点修复

- 升级流程新增 OpenClaw runtime 收敛阶段，升级成功不再只以 build 完成为准。
- 升级后会自动对齐 OpenClaw gateway service，修复旧 service unit 残留导致的 entrypoint mismatch。
- 升级后会自动收敛安全的本机 device repair 请求，补齐本地 operator scopes，避免浏览器工具被 `pairing required` 卡住。
- 升级后会自动验收浏览器 runtime，依次验证 `browser status`、`browser start`、`browser open https://example.com`、`browser snapshot`，任一步失败都不会标记为升级完成。

## 重要改进

- 最大化权限开关改为即时响应，切换后无需刷新页面即可再次开关，网关重启改为后台串行处理。
- 更新状态新增 runtime 收敛相关 phase，升级过程可以看到 OpenClaw runtime 修复和浏览器恢复阶段。
