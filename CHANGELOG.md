## [1.5.0] — 2026-09-03

### 撤回 v1.3.0–v1.4.0 的外接 Agent 方案，改走模型 ref

v1.3.0 的运行时下拉框写的是引擎明确忽略的键（whole-agent runtime keys are
legacy and ignored）。生产实测：选了 Claude Code 的 Agent 回答自己是
DeepSeek-V4-Flash，且无任何报错。整块移除，并在每次 provision 时清理已经写进
用户配置的废键——只删代码不清理，等于把骗人的状态留在原地。

v1.4.0 的凭据页把 Key 写进 ~/.openclaw/.env，而引擎要的是自己的 auth profile。
整页移除。

正确接法：外接 Agent 就是一个模型 ref（claude-cli/claude-sonnet-5），走现有的
模型接入，零新代码。它因此天然能单独对话、进团队、配预设。
实测只有 claude-cli 后端已注册；gemini/codex/opencode 需 ACP，暂不放进界面。

详见 docs/release-notes-v1.5.0.md。

## [1.4.0] — 2026-09-03

### 外接 Agent 凭据可在网页配置；并修正上一版接错凭据库

v1.3.2 读 openclaw 的 auth-profiles 判断 Claude Code 有没有登录，那是错的库——
外接 Agent 用各家 CLI 自己的凭据。后果是页面自信地显示错的状态。

现在页面上直接填 API Key，写入 ~/.openclaw/.env（600）并重启 Gateway 生效。
这是引擎文档给的路径（provide the required provider key on the Gateway host
environment），不需要 TTY。

状态去掉了「未登录」：我们只确知自己写的变量在不在，说不出厂商 CLI 的登录状态。
Pi 无环境变量，如实标为「只能在主机上登录」。

详见 docs/release-notes-v1.4.0.md。

## [1.3.2] — 2026-09-03

### 新增：运行时账号页；修复：副标题显示错的信息

v1.3.0 能选运行时但没地方登录，功能只做了一半。新增设置页显示每个运行时的
登录状态与该敲的命令（统一 device-code，凭据不经过 ClawOPT）。
**不代为执行**——Gateway 协议里没有 authLogin，而代执行需要主机 shell 权限。

状态三态：探测失败显示「状态未知」而不是「未登录」，因为 --force 重登会删掉
现有 profile。

侧边栏副标题原来对 ACP Agent 显示模型名（如 DeepSeek），那不是在跑它的东西。
改为显示运行时。

详见 docs/release-notes-v1.3.2.md。

# CHANGELOG

本项目的版本记录从 1.0.0 重新开始。
基线为上游 ClawOPT v2.4.5，其历史见 `docs/_upstream-archive/`。

## [1.3.0] — 2026-09-03

### 新增：在界面上给 Agent 选运行时

OpenClaw 2026.8 支持让一个 Agent 由 Claude Code / Gemini CLI / OpenCode / Pi /
Codex 来执行，但 ClawOPT 界面上无从表达。这一版加了「运行时」下拉框，
并如实告知每个选项需要什么账号。

选中的 Agent 与普通 Agent 完全一样——能单聊、能进团队，**不需要额外代码**。

顺带修了一个更老的问题：ClawOPT 的会话列表不读 \，
引擎侧建的 Agent 它看不见。新增 \ 与
\。

详见 [\](docs/release-notes-v1.3.0.md)。

## [1.2.6] — 2026-09-03

### 修复：会话库路径少写了一层，导致 v1.2.5 的诚实降级从未生效

判据写的是 `agents/<id>/openclaw-agent.sqlite`，真机上是
`agents/<id>/agent/openclaw-agent.sqlite`。少一层的后果不是报错，
是**判据永远不成立**——升级后界面照样空白，而我们以为修好了。

单元测试没抓住，因为**用例和实现共享同一个错误假设**。
本版按真机目录形状补了回归用例。
详见 [`docs/release-notes-v1.2.6.md`](docs/release-notes-v1.2.6.md)。

## [1.2.5] — 2026-09-03

### 修复：v1.2.4 的名册门面没有被调用

v1.2.4 发布了门面的代码，但 `agent-provisioner.ts` 仍在直接操作 `agents.list`——
**升级 OpenClaw 到 2026.8 后，通过 ClawOPT 新建的 Agent 引擎看不见**。

移植时 `git apply` 报成功实际没写入，而那条该抓住它的用例住在同一个被修改的文件里，
**守卫和被守卫的代码一起消失**，测试套件全绿。

本版加了一道住在独立文件里的机械守卫：只断言接线存在，不断言行为。
详见 [`docs/release-notes-v1.2.5.md`](docs/release-notes-v1.2.5.md)。

## [1.2.4] — 2026-09-03

### 新增：为 OpenClaw 2026.8 做好准备

让**同一份代码同时正确工作于 OpenClaw 2026.7.x 与 2026.8.x**。无新功能。
**打算升级 OpenClaw 的话，请先升到这一版，再升引擎。**

- **名册门面**：统一 `agents.list[]`（旧）与 `agents.entries{}`（新），
  策略是「跟随现状，不主动迁移」——迁移是 `openclaw doctor` 的职责。
  探测不到引擎版本时按 `list` 走，因为两个方向的失败代价不对称。
- **版本探测不再 shell out**：`openclaw --version` 成不成功取决于谁的 PATH 在前。
  改为解析 `command -v openclaw` 指向的那一份的 `package.json`。
- **部署链路加迁移闸门**：引擎 2.x 且配置有废弃键时先跑 `doctor --fix
  --non-interactive` 并校验退出码，失败阻断部署。
- **「读不到」不再伪装成「没有数据」**：2.x 上读不到系统提示词报告时界面明说，
  并把此前无人消费的 `configReadFailed` 接上了。

详见 [`docs/release-notes-v1.2.4.md`](docs/release-notes-v1.2.4.md)。

## [1.2.3] — 2026-09-02

### 修复：配置访问加固

只做一件事——把读写 `~/.openclaw` 配置这条线收进一个受控入口。
无新功能、无界面变化、无迁移步骤。以下缺陷在 v1.2.2 及更早版本上**全部存在**：

- **命名管道能永久挂死后端**，且其中两条入口匿名可达（默认不开登录）。
  所有配置读取现在先确认目标是普通文件。
- **配置解析报错把凭据带进 HTTP 响应体** —— V8 有一类 JSON 报错会嵌入输入原文，
  而 `openclaw.json` 里存着 gateway 凭据与全部模型 apiKey。现在只保留错误码与位置。
- **写配置会先把它截断成 0 字节** —— 跨进程实测 7 次写入中 3 次读到零长度。
  改为「临时文件 → fsync → rename」，并穿透符号链接。
- **配置读不动时装配「成功」而什么都没写**，包括 `null` / `[]` / `{"agents":[]}`
  这几种 `JSON.parse` 会成功返回的形状。现在明确失败，四种原因可分辨。
- **删除报成功而一个字节没删**（`DELETE /api/sessions/:id`）。

详见 [`docs/release-notes-v1.2.3.md`](docs/release-notes-v1.2.3.md)，
含可复现步骤与已知限制。

> **本文件此前只记到 1.0.0。** 1.1.0 – 1.2.2 的记录在 `docs/release-notes-v*.md` 里，
> 没有回填进这里——回填一份我没有参与的历史，比留下这个缺口更容易出错。

## [1.0.0] — 未发布

### 改造
- 全项目品牌标识符改名，与上游可在同一主机共存
- 移除上游的社群 / 资源站 / 付费 API 推广位
- 更新源与版本检查指向本项目仓库
- 新增 `branding.json` + `scripts/apply-branding.mjs`，换品牌变成一处改动
- 安装脚本默认路径改为「先下载、先阅读、再执行」

### 新增
- `presets/` 角色预设库（内容层）
