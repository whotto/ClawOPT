# OpenClaw Chat Gateway v2.0.4

## 重点修复

- 浏览器自动修复与浏览器健康检查统一采用 OpenClaw 官方验证链路：`status -> start -> open https://example.com -> snapshot`。
- 不再因为当前 service 进程环境缺少 `DISPLAY` / `WAYLAND_DISPLAY`，就把 `browser.headless=true` 静默持久化写回 `openclaw.json`，避免桌面机被误污染成“无头模式”。
- 浏览器健康检查后端现在明确区分“配置态”和“运行态”，页面显示不再把 `config.headless` 误当成浏览器当前真实运行模式。

## 重要改进

- 浏览器健康接口会返回更完整的配置诊断信息，包括 profile、`executablePath`、`noSandbox`、`attachOnly`、`cdpPort`，便于定位 OpenClaw 浏览器配置问题。
- 当 `https://example.com` 遇到证书拦截页时，健康检查和 runtime 收敛会识别证书告警，再用 `http://example.com` 做 runtime 可用性确认，避免把证书页误判成浏览器不可用。
- 设置页浏览器健康卡片改为优先显示运行态字段；拿不到实时运行态时才显示 `未知`，不再把配置值冒充运行时真值。
- 升级脚本现在会在 `git pull` 前和部署完成后清理部署目录里被 `npm` 改写的 lockfile，避免上一次部署留下脏工作树，导致下一次自动升级卡在 `git-pull`。

## 验证范围

- 已在真实 OpenClaw Linux 主机上完成构建验证。
- 目标验证机 `192.168.3.23` 将通过自动升级到 `2.0.4` 后再做浏览器链路验收，重点核对健康页与 `openclaw browser` CLI 实际状态是否一致。
