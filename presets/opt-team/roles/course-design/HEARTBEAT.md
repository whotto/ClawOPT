# HEARTBEAT.md —— 已退役（保留作迁移说明与人类可读意图）

> **当前版本的 OpenClaw 不再创建、也不再在运行时读取 `HEARTBEAT.md`。**
> 心跳指令现在存放在系统托管的 monitor 任务的 cron scratch（共享状态数据库）里；
> 周期性任务用 automations（定时任务）表达。
>
> 本文件保留在工作区，只有两个用途：
> 1. 给人看：这个角色**打算**周期性做什么
> 2. 迁移锚点：`openclaw doctor --fix` 会把这里的指令导入 monitor scratch、
>    把合法的 legacy `tasks:` 条目转成 cron 任务、把原文件归档到 state 目录并删除工作区副本

## 迁移方式

```bash
# 方式一（推荐）：自动迁移
openclaw doctor --fix

# 方式二：手动写入 monitor scratch
openclaw automations list --all              # 找到 monitor 任务的 jobId
openclaw automations scratch <jobId> --set "..."
openclaw automations scratch <jobId> --file HEARTBEAT.md
openclaw automations scratch <jobId> --unset

# 方式三：把周期任务建成真正的定时任务
bash automations.sh
```

## 心跳 vs 定时任务：怎么选

| 需求 | 用什么 |
|------|--------|
| 批量的周期性检查，需要完整会话上下文，时间点大概就行（默认约 30 分钟一次） | **心跳** |
| 精确时间、独立运行、要换模型、一次性提醒 | **定时任务 automations** |
| 事件触发（"下次谁提到 X 就提醒我"） | **长效意图 standing intent** |

## 本角色的心跳清单（写进 scratch 的内容）

1. **课程趋势监测**（每周）：搜索 AI 落地培训的最新案例和方法，更新课程内容库
2. **工具生态追踪**（每周）：监测主流 AI 工具的版本与能力更新，同步到课程设计；**必须联网核实，不用训练知识**
3. **学员反馈收集**（每两周）：主动问"最近设计的课程效果如何？有哪些需要调整？"
4. **课程质量复盘**（每月）：回看本月交付的课程包，哪些被实际使用、哪些被改动、改动说明了什么
5. **新 Skill 搜索**（每月，可选）：发现更好的课程设计/PPT 生成工具；安装前必检安全性并先问{{USER_TITLE}}
6. 每隔几天做一次记忆维护：稳定偏好折进 `USER.md`，课程资产与反馈折进 `MEMORY.md`
7. 深夜 23:00–08:00 保持安静，除非紧急
8. 如无异常，回复 `HEARTBEAT_OK`
