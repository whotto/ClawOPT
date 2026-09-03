# v1.3.0 —— 在界面上给 Agent 选运行时

升级到 OpenClaw 2026.8 之后，一个 Agent 可以由**别的 Agent 来执行**——
Claude Code、Gemini CLI、OpenCode、Pi、Codex。引擎早就支持了，
但 ClawOPT 界面上无从表达，所以这个能力一直用不上。

这一版把它接出来。

## 加了什么

**建 Agent 时多一个「运行时」下拉框**：

| 选项 | 谁来跑 | 需要什么账号 |
|---|---|---|
| OpenClaw（默认） | 引擎自己 | — |
| Claude Code | ACP/acpx | Anthropic |
| Gemini CLI | ACP/acpx | Google |
| OpenCode | ACP/acpx | 看后端模型 |
| Pi | ACP/acpx | Pi |
| Codex | ACP/acpx | OpenAI |

选了非默认项之后，界面会**当场说明它需要什么账号**——没登录的话这个 Agent
回不了话，这件事应该在建之前就知道，不是建完才发现。

**选中的 Agent 与普通 Agent 完全一样**：能单独对话、能加进团队。
不需要任何额外代码，因为对 ClawOPT 来说它就是引擎名册里的一项。

## 顺带修了一个更老的问题

ClawOPT 的会话列表来自它自己的数据库，**不读 `openclaw.json`**。
所以任何在引擎侧建的 Agent——用 `openclaw agents` 建的、手改配置建的、
从别处迁移来的——ClawOPT 都看不见，既不能单聊也不能进团队。

新增两个接口：

- `GET /api/agents/orphans` —— 报告「引擎里有、ClawOPT 里没有」的 Agent
- `POST /api/agents/import` —— 把其中一个纳进来

**导入只建 ClawOPT 侧的记录，不碰 `openclaw.json`**：那个 Agent 在引擎里
已经是对的，重写它只会引入一次不必要的 gateway 重载，以及一个
「导入把我的配置改了」的意外。

## 前置条件

Claude Code / Gemini / OpenCode / Pi 走的是 ACP，需要引擎侧先装好 acpx：

```bash
openclaw plugins install @openclaw/acpx --accept-capabilities
openclaw config set plugins.entries.acpx.enabled true --strict-json
openclaw config set acp.enabled true --strict-json
openclaw config set acp.backend '"acpx"' --strict-json
```

适配器（Claude Code 本体等）**不用手动装**——acpx 首次使用时用 `npx` 自动拉。
注意这意味着第一次用某个运行时会有一次下载，内存或磁盘紧张的机器要留意。

Codex 还有一条**不需要 ACP 的原生路径**（把模型 ref 设成 `openai/*`），
引擎自带文档建议优先用它；下拉框里的 `Codex` 走的是 ACP 那条，
供明确需要 ACP 行为时使用。

## 已知限制

- **运行时清单只列了 6 项，而 acpx 内置 18 个**（还有 copilot / cursor / droid /
  kimi / kiro / qwen / trae 等）。只列出验证过路径的那几个是有意的：
  **列出来就等于承诺它能用**。加一个的成本是 `agent-runtimes.ts` 里加一行。
- **本版没有真机跑通任何一个外部运行时的对话**——那需要对应平台的账号。
  验证到的是：引擎接受这个配置、ClawOPT 写得对、读得回、界面显示正确。
  「能不能真的对上话」取决于你的账号，不取决于这一版。
- `/api/agents/orphans` 只报告不自动导入，界面入口留到下一版。

## 验证

- `npm test`：**188 passed**（v1.2.6 为 175）
- 红证：运行时不写进名册 → 3 条红；默认值也落盘 → 3 条红
- 三语键集一致；`npm run build` 退出码 0
