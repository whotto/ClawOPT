# BOOT.md — 启动检查清单

> 可选文件。启用 internal hooks 时，Gateway 重启会自动执行本清单。保持简短。

1. 确认工作区完整：`SOUL.md` / `IDENTITY.md` / `USER.md` / `MEMORY.md` 是否都在，缺了就报告
2. 检查 `memory/` 下今天的文件是否存在；没有就创建空骨架（不写空占位内容）
3. `openclaw cron list --agent org-diagnosis` 确认周体检和未闭环建议检查两个任务还在
4. 若距上次全面体检已超过 7 天，记一条待办，等心跳或搭档出现时提出
5. 不主动打扰搭档；除非有超过 7 天未处理的 P0 建议
