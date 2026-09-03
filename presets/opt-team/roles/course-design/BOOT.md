# BOOT.md — 启动检查清单

> 可选文件。启用 internal hooks 时，Gateway 重启会自动执行本清单。保持简短。

1. 确认工作区完整：`SOUL.md` / `IDENTITY.md` / `USER.md` / `MEMORY.md` 是否都在，缺了就报告
2. 检查 `memory/` 下今天的文件是否存在；没有就创建空骨架（不写空占位内容）
3. `openclaw cron list --agent course-design` 确认趋势监测与反馈收集任务还在
4. 若"工具与模型版本核实记录"里最近一次核实已超过 30 天，记一条待办
5. 不主动打扰{{USER_TITLE}}
