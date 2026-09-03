# v1.5.0 —— 撤掉两个骗人的界面，外接 Agent 走模型

这一版删的比加的多。v1.3.0 到 v1.4.0 那条路是错的，全部撤回。

## v1.3.0 的「运行时」下拉框从来没生效过

它往 `agents.entries.<id>.runtime` 写 `{type:'acp', acp:{agent:'claude'}}`。
引擎文档原话：

> whole-agent runtime keys are **legacy and ignored**.
> —— `docs/concepts/agent-runtimes.md`

生产实测：建一个选了 Claude Code 的 Agent，问它「你是哪个模型」，
回答 **`DeepSeek-V4-Flash，DeepSeek`**。

选了等于没选，而且**没有任何报错**。一个静默失效的选项比没有这个选项更糟——
用户会以为自己配好了。

**光删代码不够**，已经写进配置里的废键会留在原地。所以每次 provision 都删一次，
让升级本身把上一版的痕迹清干净。

## v1.4.0 的凭据页写错了地方

它把 API Key 写进 `~/.openclaw/.env`。引擎要的是自己的 auth profile
（`openclaw models auth paste-api-key --provider <id>`）。整页移除。

## 正确的接法：外接 Agent 就是一个模型

`claude-cli/claude-sonnet-5` 是一个**模型 ref**。把 Agent 的模型设成它，
这个 Agent 就跑在主机上真实的 Claude Code 进程里。

这样它天然能单独对话、能进团队、能配预设——因为它就是名册里一个正常 Agent，
不需要第二套机制。

生产上验到最后一格：

```
✅ 装 Claude Code CLI 2.1.259
✅ 白名单加 claude-cli/*
✅ ClawOPT 现有的「新增模型」接口直接就能加，零代码改动
✅ 建 Agent 选这个模型 → 名册写入 model: "claude-cli/claude-sonnet-5"
✅ 发消息 → 请求真的进了 claude 子进程
   返回它自己的 "Not logged in · Please run /login"
```

最后那句是 **Claude Code 自己说的**，不是 OpenClaw 编的。跟之前那个悄悄回
DeepSeek 的形成对照：现在它失败得响亮且正确。

### 侧边栏副标题也因此变对了

原来要为外接 Agent 做一套单独的运行时显示。现在不用了：外接 Agent 的模型别名
就是 `Claude Code`，副标题显示模型别名，两种 Agent 都对。**少一套逻辑。**

## 只有 Claude Code 有这条路

实测四个 CLI 后端的注册情况：

| | 模型 ref |
|---|---|
| Claude Code | ✅ `claude-cli/*` |
| Gemini CLI | ❌ Unknown model |
| Codex CLI | ❌ Unknown model（另有原生 `openai/*` 谐调器路线） |
| OpenCode | ❌ Unknown model |

这三个要作为外接 Agent 只有 ACP 一条路。**不放进界面骗人**，等真做了再放。

## 验证

- `npm test`：**179 passed**（v1.4.0 是 206，减少的是被删功能的用例）
- 红证 2 条：不再清理遗留键 → 2 红；有人把写入加回来 → 4 红
- fs 调用点从 58 降回 57
- 三语键集一致；`npm run build` 退出码 0
