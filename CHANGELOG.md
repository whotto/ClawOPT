# CHANGELOG

本项目的版本记录从 1.0.0 重新开始。
基线为上游 ClawOPT v2.4.5，其历史见 `docs/_upstream-archive/`。

## [1.0.0] — 未发布

### 改造
- 全项目品牌标识符改名，与上游可在同一主机共存
- 移除上游的社群 / 资源站 / 付费 API 推广位
- 更新源与版本检查指向本项目仓库
- 新增 `branding.json` + `scripts/apply-branding.mjs`，换品牌变成一处改动
- 安装脚本默认路径改为「先下载、先阅读、再执行」

### 新增
- `presets/` 角色预设库（内容层）
