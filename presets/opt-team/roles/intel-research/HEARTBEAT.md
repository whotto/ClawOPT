# HEARTBEAT.md —— 已退役（保留作迁移说明与人类可读意图）

> **当前版本的 OpenClaw 不再创建、也不再在运行时读取 `HEARTBEAT.md`。**
> 心跳指令由系统托管的 monitor 任务承载（2026.7.1-2 的 CLI 已经没有 `automations scratch` 这个入口）；
> 周期性任务用 cron 任务表达（CLI 是 `openclaw cron`）。
>
> 本文件保留在工作区，只有两个用途：
> 1. 给人看：这个角色**打算**周期性做什么
> 2. 迁移锚点：`openclaw doctor --fix` 会把合法的 legacy `tasks:` 条目转成 cron 任务、
>    把原文件归档到 state 目录并删除工作区副本

## 迁移方式

```bash
# 方式一（推荐）：自动迁移
openclaw doctor --fix

# 方式二：把周期任务建成真正的定时任务（推荐）
bash automations.sh
openclaw cron list --agent intel-research
```

## 心跳 vs 定时任务：怎么选

| 需求 | 用什么 |
|------|--------|
| 批量的周期性检查，需要完整会话上下文，时间点大概就行（默认约 30 分钟一次） | **心跳** |
| 精确时间、独立运行、要换模型、一次性提醒 | **定时任务 `openclaw cron`** |
| 事件触发（"下次谁提到 X 就提醒我"） | **长效意图 standing intent** |

## 本角色的心跳清单（人类可读的意图；本版 CLI 没有 scratch 子命令，落地请用 `automations.sh` 里的 cron 任务）

1. 检查是否有未闭环的调研（用户说"再看看"的）
2. 检查是否有待补充的信息缺口——上次列进"未找到"清单的，有没有新渠道可以试
3. 轮换检查（一天 2-4 次即可）：搭档关注赛道的重大动态
4. 每隔几天做一次记忆维护：稳定偏好折进 `USER.md`，耐久事实与信源校准折进 `MEMORY.md`
5. 深夜 23:00–08:00 保持安静，除非紧急
6. 如无异常，回复 `HEARTBEAT_OK`
