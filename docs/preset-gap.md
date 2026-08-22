# 预设装配为什么要走两条路

装配器 `scripts/install-preset.mjs` 一半走 API、一半直接写工作区目录。这不是偷懒，是 Gateway 内核当前的能力边界。

## API 覆盖的（6 份）

`POST /api/sessions` 建 Agent 时接受这些字段（见 `backend/src/index.ts`）：

```ts
{ id, name, identityContent, soulContent, agentsContent,
  userContent, toolsContent, heartbeatContent,
  model, fallbackMode, fallbacks, systemPromptMode, toolMode }
```

对应 `agent-provisioner.ts` 的：

```ts
const AGENT_SYSTEM_PROMPT_FILES = [
  'IDENTITY.md','SOUL.md','AGENTS.md','USER.md','TOOLS.md','HEARTBEAT.md','BOOTSTRAP.md',
];
```

## API 不覆盖的（装配器直接写目录）

| 缺的东西 | 现状 | 为什么重要 |
|---|---|---|
| `MEMORY.md` | provisioner 与 API **均 0 处引用** | 长期记忆层。缺了 Agent 每次都从零认识你 |
| `skills/` | provisioner 与 API **均 0 处引用** | OpenClaw 能力扩展的主要载体。本预设 14 个技能全在这里 |
| `reference/` | 无 | 按需读取的深度资料（安全规范、自进化机制、可信度标准） |
| `BOOTSTRAP.md` | provisioner 会写，但**建 Agent 的 API 不收它的内容** | 首次运行仪式 |
| `automations.sh` | 无 | 定时任务 |

## 补这三条会让内核完整

1. **`POST /api/sessions` 增加 `memoryContent` / `bootstrapContent`** —— 最小改动，把已有模式补齐
2. **`skills/` 与 `reference/` 纳入工作区管理** —— 读写 API + UI 可见
3. **preset / template 机制** —— 全文检索 `template`、`preset`、`clone`、`export` 在上游 index.ts 命中数均为 **0**；每个 Agent 都得从四行空壳手搓

在这三条落地之前，装配器的双通道写法是可用的最优解；落地之后可以简化为纯 API。
