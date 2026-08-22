#!/usr/bin/env bash
# 组织诊断 — 推荐定时任务（一次性执行即可全部创建）
set -euo pipefail
TZ_ARG="--tz Asia/Shanghai"
SESSION="--session main"

echo "==> 每周一 10:00 · 团队五维体检"
openclaw automations add --name "组织诊断-每周体检" --cron "0 10 * * 1" $TZ_ARG $SESSION \
  --system-event "执行每周团队体检：轻量扫描五维健康（配置完整度/技能完备度/使用活跃度/输出质量/协作效能），与上周基线对比，输出简报到 memory/heartbeat-weekly-YYYY-MM-DD.md。只读，不修改任何被诊断 Agent 的文件。"

echo "==> 每日 09:00 · 未闭环建议检查"
openclaw automations add --name "组织诊断-未闭环建议" --cron "0 9 * * *" $TZ_ARG $SESSION \
  --system-event "检查上次诊断的改进建议执行情况。有超过 7 天未处理的 P0 建议就主动提醒搭档；没有则回 HEARTBEAT_OK。"

echo "==> 每月 1 日 10:00 · 诊断质量复盘"
openclaw automations add --name "组织诊断-月度复盘" --cron "0 10 1 * *" $TZ_ARG $SESSION \
  --system-event "月度复盘：本月做过哪些诊断、哪些建议被采纳、哪些被搁置及原因、五维趋势是好转还是恶化。把结论折进 MEMORY.md。"

echo "==> 每周五 18:00 · 记忆维护"
openclaw automations add --name "组织诊断-记忆维护" --cron "0 18 * * 5" $TZ_ARG $SESSION \
  --system-event "记忆维护：读本周 memory/YYYY-MM-DD.md，稳定偏好折进 USER.md 的 Directives（就地废止旧条目），耐久事实与决策折进 MEMORY.md，删除过期条目。"

echo "完成。查看：openclaw automations list"
