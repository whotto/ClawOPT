# OpenClaw Chat Gateway v2.0.5

## 重点改进

- 浏览器设置区新增“有头模式”开关，位置放在“浏览器”标题右侧，样式与现有设置开关保持一致。
- 页面进入网关设置时，会直接读取本机 `~/.openclaw/openclaw.json` 里的 `browser.headless` 真值来初始化开关状态，不再依赖慢速健康检查结果推断。
- 点击开关会立即更新 `browser.headless`：
  - 打开“有头模式”会写入 `false`
  - 关闭“有头模式”会写入 `true`

## 后端支持

- 新增浏览器有头模式配置接口：
  - `GET /api/config/browser-headed-mode`
  - `POST /api/config/browser-headed-mode`
- 配置写入成功后，会后台执行浏览器 best-effort stop 并排队重启 gateway，让新模式尽快生效。

## 稳定性

- 浏览器设置相关错误提示已补齐 `zh-CN`、`zh-TW`、`en` 三语文案。
- 本次发布继续保持根 `package.json.version` 作为唯一版本真值源，并与 Git tag、GitHub Release 同步。
