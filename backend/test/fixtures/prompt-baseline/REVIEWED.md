# 基线复审记录

`prompt-baseline.test.ts` 的闸门要求：`group-chat-engine.ts` 每次改动之后，基线目录都要有一次
晚于该改动的提交，证明有人对着七份快照重新审视过。快照本身逐字节不变时，git 记不下「看过了」，
所以在这里记一笔。**只准追加，不准改快照。**

| 日期 | 引擎改动 | 复审结论 |
|---|---|---|
| 2026-09-04 | a732c3c（v1.5.2）：历史窗口从 `slice(-15)` 改为 `selectGroupContextWindow`（条数 + 字符预算 + 触发消息去重，均在调用方 `sendToAgent`）；`buildAgentPrompt` 内新增 `truncateGroupTriggerMessage`，仅在「最新任务」超过 6000 字时生效；`maxDepth === 0` 分支改为写系统消息。 | 七份快照字节相同（本次运行 `七种输入的字节快照与签入的基线逐字节一致` 通过）。矩阵里没有 >6000 字的触发消息，也不经过调用方裁剪，故 `buildAgentPrompt` 对矩阵输入的输出不变。红线 A 未被破坏。 |
