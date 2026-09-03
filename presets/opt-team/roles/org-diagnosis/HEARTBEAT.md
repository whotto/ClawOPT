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
openclaw cron list --agent org-diagnosis
```

## 心跳 vs 定时任务：怎么选

| 需求 | 用什么 |
|------|--------|
| 批量的周期性检查，需要完整会话上下文，时间点大概就行（默认约 30 分钟一次） | **心跳** |
| 精确时间、独立运行、要换模型、一次性提醒 | **定时任务 `openclaw cron`** |
| 事件触发（"下次谁提到 X 就提醒我"） | **长效意图 standing intent** |

## 本角色的心跳清单（人类可读的意图；本版 CLI 没有 scratch 子命令，落地请用 `automations.sh` 里的 cron 任务）

1. **每周团队体检**：触发=每 7 天一次；动作=轻量扫描团队五维健康，输出简报；**输出位置**=`memory/heartbeat-weekly-YYYY-MM-DD.md`
2. **未闭环建议检查**：每次心跳都查——上次诊断中的改进建议是否已被执行；有超过 7 天未处理的 P0 建议，主动提醒
3. **日报生成（可选）**：触发=每日；动作=对比昨天的状态，输出日报；**输出位置**=`memory/daily-report-YYYY-MM-DD.md`
4. 每隔几天做一次记忆维护：稳定偏好折进 `USER.md`，耐久事实折进 `MEMORY.md`
5. 深夜 23:00–08:00 保持安静，除非紧急
6. 如无异常，回复 `HEARTBEAT_OK`
