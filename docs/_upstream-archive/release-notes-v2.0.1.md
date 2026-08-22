# OpenClaw Chat Gateway v2.0.1

OpenClaw Chat Gateway v2.0.1 是一次面向部署稳定性与版本可见性的补丁更新，重点修复生产环境中 `openclaw` CLI 路径解析不稳定的问题，并补齐设置页与左侧栏的真实版本展示。

## 重点改进

- 修复部署后 `openclaw` CLI 路径解析问题
  - 后端现在会优先解析 `openclaw` 可执行文件的真实路径，不再单纯依赖服务进程的 `PATH`。
  - 修复了部分 Linux 主机在 user-level systemd 服务环境下无法找到 `openclaw` 的问题。
  - 对“最大化权限”、“浏览器自愈”、“重启网关”等依赖 `openclaw` CLI 的操作更稳定。

- 补强发布部署模板
  - `clawui.service` 与 `deploy-release.sh` 现在会显式补齐常见 npm 全局安装目录的 `PATH`。
  - 降低升级到新版本后因为 systemd 环境变量不完整导致功能异常的风险。

- 设置页与侧栏显示真实 OpenClaw 版本
  - `/api/version` 现在会返回当前 OpenClaw 版本。
  - 网关设置页可直接显示当前 OpenClaw 版本。
  - 左侧设置栏目顶部同步显示 `OpenClaw` 版本与 `CHAT GATEWAY` 当前版本。

## 体验优化

- 优化设置页“OpenClaw / 版本号”排版
  - 网关设置标题与版本信息样式统一收口。
  - 左侧栏标题区的版本字号、单行显示与底部对齐效果已优化。

## English Summary

OpenClaw Chat Gateway v2.0.1 is a patch release focused on deployment reliability and clearer version visibility.

- Fixed `openclaw` CLI resolution in deployed environments where systemd user services did not inherit the expected `PATH`
- Hardened service and deploy templates by injecting common npm global bin paths
- Added real OpenClaw version reporting to `/api/version`, the gateway settings page, and the settings sidebar
- Polished version label alignment and display in the settings UI
