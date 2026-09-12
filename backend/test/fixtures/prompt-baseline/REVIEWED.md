# 基线复审记录

`prompt-baseline.test.ts` 的闸门要求：`group-chat-engine.ts` 每次改动之后，基线目录都要有一次
晚于该改动的提交，证明有人对着七份快照重新审视过。快照本身逐字节不变时，git 记不下「看过了」，
所以在这里记一笔。**只准追加，不准改快照。**

| 日期 | 引擎改动 | 复审结论 | 判定用时 |
|---|---|---|---|
| 2026-09-04 | a732c3c（v1.5.2）：历史窗口从 `slice(-15)` 改为 `selectGroupContextWindow`（条数 + 字符预算 + 触发消息去重，均在调用方 `sendToAgent`）；`buildAgentPrompt` 内新增 `truncateGroupTriggerMessage`，仅在「最新任务」超过 6000 字时生效；`maxDepth === 0` 分支改为写系统消息。 | 七份快照字节相同（本次运行 `七种输入的字节快照与签入的基线逐字节一致` 通过）。矩阵里没有 >6000 字的触发消息，也不经过调用方裁剪，故 `buildAgentPrompt` 对矩阵输入的输出不变。红线 A 未被破坏。 | 未记录 |
| 2026-09-12 | v1.8.0 三处改动，**全部在 `buildAgentPrompt` 之外**：① 每成员一把锁（`acquireMemberLock` / `releaseMemberLock`，加在 `sendToAgent` 里成员解析之后、落占位消息之前）；② `sendUserMessage` 撤掉整轮群锁，重新生成路径保持不变；③ 新增 `runExternalMember` 外部运行时分支，它在 `sendToAgent` 内提前 return，不进网关流程。 | 七份快照字节相同（本次运行「七种输入的字节快照与签入的基线逐字节一致」通过）。`buildAgentPrompt` 函数体一行未改；三处改动都发生在它的调用方或更外层，且外部分支根本不调用它（外部 Agent 的群上下文走 `--append-system-prompt`，不复用这条 prompt 组装路径）。红线 A 未被破坏。 | <1 分钟（快照比对自动通过 + 人工确认 buildAgentPrompt 未改） |
| 2026-09-12（第二次） | 借鉴 OpenOPC 的三处改动：① 会话可续性改成状态判定（`getResumableExternalSession` 取代 `getExternalSession`，改的是 `runExternalMember` 内部）；② 新增 `heldMemberLockSnapshot()`，纯读 `processingMembers`，只给 `/api/diagnostics` 用；③ 长 prompt 走 stdin（改在 `external-agents/claude-code.ts`，不在本文件内）。 | 七份快照字节相同（本次运行「七种输入的字节快照与签入的基线逐字节一致」通过）。`buildAgentPrompt` 函数体仍未改动；②是新增的只读方法，①只影响外部运行时分支（它根本不调用 `buildAgentPrompt`，外部 Agent 的群上下文走 `--append-system-prompt`）。红线 A 未被破坏。 | <1 分钟（同上） |

> **判定用时这一列是个元信号。** 如果某天它开始上涨（比如从 1 分钟到 20 分钟），
> 说明快照集在膨胀或结构在漂移——那时候该重构快照维度，而不是继续硬扛。
| 2026-09-12（第三次） | 拆分「群忙不忙」与「能不能接新消息」两个判据：新增 `isGroupBlockingNewMessage()`（不含成员锁），`isGroupProcessing()` 语义不变。只动这两个方法与三处路由调用点。 | 七份快照字节相同（本次运行「七种输入的字节快照与签入的基线逐字节一致」通过）。`buildAgentPrompt` 函数体仍未改动；本次改的是准入判据与路由，与 prompt 组装无关。红线 A 未被破坏。 | <1 分钟（同上） |
