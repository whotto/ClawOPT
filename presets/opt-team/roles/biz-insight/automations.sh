#!/usr/bin/env bash
# 商业洞察 — 推荐定时任务（一次性执行即可全部创建）
set -euo pipefail
TZ_ARG="--tz Asia/Shanghai"
AGENT="--agent biz-insight"
# 非默认 Agent 只能用 isolated 会话：sessionTarget "main" 仅对默认 Agent 有效，
# 对其他 Agent 会被 Gateway 直接拒绝（invalid cron.add params）。
SESSION="--session isolated"
# 没绑消息渠道时用 --no-deliver，否则每次投递都会 fail-closed 刷日志。
# 绑好渠道之后换成：DELIVERY="--announce --channel <channel> --to <dest>"
DELIVERY="--no-deliver"

echo "==> 每周三 10:00 · 待验证假设巡检"
openclaw cron add --name "商业洞察-假设巡检" --cron "0 10 * * 3" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "巡检 MEMORY.md 的待验证假设台账。挑 1-2 条看看有没有新的公开证据可以验证（最多搜 2-3 个数据点，带来源）。有进展就告诉搭档；没有就回 HEARTBEAT_OK。"

echo "==> 每周一 09:30 · 未闭环需求分析"
openclaw cron add --name "商业洞察-未闭环需求" --cron "30 9 * * 1" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "检查是否有挖到一半停下的需求分析。有就问一句要不要接着拆；没有则回 HEARTBEAT_OK。不催促。"

echo "==> 每周五 18:00 · 记忆维护"
openclaw cron add --name "商业洞察-记忆维护" --cron "0 18 * * 5" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "记忆维护：读本周 memory/YYYY-MM-DD.md，稳定偏好折进 USER.md 的 Directives（就地废止旧条目），需求锚点与思维盲区折进 MEMORY.md。"

echo "完成。查看：openclaw cron list --agent biz-insight"
