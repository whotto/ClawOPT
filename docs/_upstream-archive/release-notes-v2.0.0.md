# OpenClaw Chat Gateway v2.0.0

OpenClaw Chat Gateway v2.0.0 是一次围绕“团队协作、长对话稳定性、模型配置体验与版本体系”展开的重要升级。这个版本重点补齐了多智能体协同工作能力，并系统性优化了聊天输出、历史分页、模型设置和版本发布流程。

## 重点新功能

- 新增“团队”模式，支持多智能体协同工作
  - 支持创建团队，让多个智能体围绕同一任务分工协作。
  - 团队运行时采用独立 workspace / runtime agent 机制，更贴合 OpenClaw 多智能体协作最佳实践。
  - 支持团队成员分工、链式协作、团队消息链路与运行态恢复。
  - 这是 v2.0.0 最核心的新能力之一。

- 支持多语种界面设置
  - 新增并完善多语言支持，覆盖 `zh-CN`、`zh-TW`、`en`。
  - 设置页、团队、聊天、模型管理、版本信息等关键界面均已接入多语言资源。

## 重要改进

- 浏览器检测与可用性强化
  - 强化浏览器健康检查、自愈与配置检测流程。
  - 对浏览器权限、运行状态、网关探测等关键环节增加更明确的检测与反馈。
  - 配合最大权限与相关设置优化，帮助浏览器能力更稳定可用。

- 历史分页优化，长聊天也能更轻量
  - 聊天历史分页统一收口为基于消息 ID 的 cursor 方案。
  - 切换会话、加载旧消息、恢复上下文时不再依赖整页重载。
  - 在聊天记录很多的情况下，能显著降低卡顿和无效刷新带来的负担。

- 模型设置能力增强
  - 支持系统默认主模型配置。
  - 支持全局故障转移模型配置。
  - 支持为单个智能体单独设置模型与故障转移链路。
  - 当主模型不可用时，可按配置顺序自动回退，提高整体可用性。

- 端点设置与模型设置整合
  - 将端点与模型管理能力进一步整合，减少来回切换。
  - 支持端点新增、编辑、连接测试、模型发现与模型管理。
  - 整体设置流程更集中，使用路径更简洁。

## 稳定性与体验修复

- 对话深度与收尾链路优化，不再容易丢消息或半句截断
  - 系统性修复单聊与团队对话中长文本显示、终态收敛、刷新恢复等问题。
  - 重点解决了消息被短前缀覆盖、回复停在半句、终态未及时稳定下发等场景。
  - 提升复杂任务、多步骤任务、长回复场景下的稳定性。

- 支持最后一轮对话编辑与重生成
  - 支持对最后一轮有效回复执行修改、重生成等操作。
  - 同时补强相关边界判断与链路收敛，避免错误目标被重生成。

- 文件与链接体验优化
  - 输出中的文件路径可自动转为可点击链接。
  - 链接展示与打开方式更清晰。
  - 文件预览能力进一步增强，覆盖更多常见文本与文档场景。

## 版本与发布体系改进

- 统一版本号唯一来源
  - 版本号统一由仓库根 `package.json.version` 管理。
  - 前端展示、后端接口、构建元信息、Git tag、GitHub Release 统一对齐。

- 新增真实版本接口与更新检查
  - 新增 `/api/version` 与 `/api/version/latest`。
  - “关于系统”页面现在可以真实显示当前版本，并检查 GitHub 最新 Release。

- 发布流程更规范
  - 支持按统一版本号自动创建 tag、同步 GitHub Release。
  - 构建时自动写入 build time / commit 等元信息。
  - 发布说明文档已补齐，便于后续标准化发版。

---

## English Summary

OpenClaw Chat Gateway v2.0.0 focuses on team collaboration, long-chat stability, model configuration, and release management.

### Highlights

- New Team mode for multi-agent collaboration
  - Create teams and let multiple agents work together on the same task
  - Separate runtime agents and workspaces for better collaboration isolation
  - A major new capability in v2.0.0

- Stronger browser health checks
  - Improved browser diagnostics, recovery flow, and runtime feedback
  - Better support for reliable browser startup and availability checks

- Better history pagination
  - Cursor-based message pagination improves performance in long conversations
  - Reduced full-page reload behavior when loading or recovering chat history

- Improved model settings
  - Configure a global primary model
  - Configure global fallback models
  - Configure per-agent fallback models independently

- Simpler endpoint + model management
  - Endpoint settings and model management are more unified
  - Easier endpoint testing, model discovery, and model configuration

- Better chat completion stability
  - Fixed missing messages, truncated replies, and incomplete finalization
  - Improved final-state settling for both direct chat and team conversations

- Edit and regenerate the latest reply
  - The latest round of conversation can now be edited or regenerated with safer validation

- Multilingual support
  - Improved support for `zh-CN`, `zh-TW`, and `en`
