# OpenClaw Chat Gateway v2.0.2

OpenClaw Chat Gateway v2.0.2 是一次聚焦“真实自动更新链路”的补丁更新。本次版本把关于页里的“检查新版本 / 发现新版本”入口收口为可实际执行的服务端升级流程，并修复升级失败后版本误报的问题。

## 重点改进

- 上线真实可用的服务端自动更新状态机
  - 新增 `/api/update/status`、`/api/update/start`、`/api/update/cancel`、`/api/update/reset`、`/api/update/restart-service`。
  - 关于页按钮现在会按真实状态切换为“发现新版本”、“正在升级”、“更新成功，点击重启服务”、“更新失败，请手动升级”。
  - 升级、停止、重启都由后端在服务器本机执行，不再只是前端文案变化。

- 升级脚本支持关键阶段进度回传
  - `update.sh` 与 `deploy-release.sh` 现在会输出可解析的阶段标记。
  - 后端可据此识别 `detect-service`、`git-pull`、`install-dependencies`、`build`、`setup-service`、`complete` 等阶段。
  - 关于页可以基于真实脚本进度更新按钮状态与提示。

- 支持可安全阶段取消升级
  - 在可安全中断的早期阶段，用户可真实终止当前升级任务。
  - 取消后会清理升级残余，并回到升级前版本状态。
  - 若流程已进入不可安全中断阶段，会明确返回不可停止，而不是假装取消成功。

## 稳定性修复

- 修复生产环境升级时 `build` 阶段可能失败的问题
  - 升级脚本现在会显式安装构建所需的 devDependencies。
  - 修复了生产服务环境下可能出现的 `tsc: not found`，确保升级流程可以穿过 `build` 阶段。

- 修复升级失败后“当前版本”提前跳到新版本的问题
  - `/api/version` 现在返回的是当前运行中服务的真实生效版本，而不是磁盘上刚被 `git pull` 下来的版本。
  - 如果升级失败且服务没有重启成功，页面仍会保持显示旧版本。
  - 只有当服务真正重启并运行新版本后，当前版本才会切换。

## 体验优化

- 关于页更新入口与错误提示体验优化
  - 更新状态、失败原因和按钮文案收口为统一交互。
  - 升级失败时可直接看到明确状态，不再出现按钮状态和版本显示互相矛盾的情况。

## English Summary

OpenClaw Chat Gateway v2.0.2 is a patch release focused on a real, server-driven update flow.

- Added real backend-controlled update endpoints for start, cancel, status polling, reset, and service restart
- Wired the About page update button to actual upgrade states instead of static UI-only text
- Added parseable phase markers to `update.sh` and `deploy-release.sh` for live progress reporting
- Fixed production upgrade failures caused by missing build-time devDependencies such as `tsc`
- Fixed version drift so `/api/version` now reports the currently running service version, not just the version already pulled to disk
