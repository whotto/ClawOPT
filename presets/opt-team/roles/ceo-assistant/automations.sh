#!/usr/bin/env bash
# CEO助理 — 推荐定时任务（一次性执行即可全部创建）
# 需要 Gateway 正在运行。查看：openclaw cron list --agent ceo-assistant
set -euo pipefail
TZ_ARG="--tz Asia/Shanghai"
AGENT="--agent ceo-assistant"
# 非默认 Agent 只能用 isolated 会话：sessionTarget "main" 仅对默认 Agent 有效，
# 对其他 Agent 会被 Gateway 直接拒绝（invalid cron.add params）。
SESSION="--session isolated"
# 没绑消息渠道时用 --no-deliver，否则每次投递都会 fail-closed 刷日志。
# 绑好渠道之后换成：DELIVERY="--announce --channel <channel> --to <dest>"
DELIVERY="--no-deliver"

echo "==> 每日 09:00 · 跟进项到期检查"
openclaw cron add --name "CEO助理-每日跟进检查" --cron "0 9 * * *" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "检查所有待跟进事项：等谁回复、什么时候到期、下一步是什么。有到期或临期的主动提醒搭档；没有就安静。"

echo "==> 每周一 09:30 · 想法池巡检"
openclaw cron add --name "CEO助理-想法池巡检" --cron "30 9 * * 1" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "巡检想法池：列出本周新增想法、仍在推进的、已沉睡超过 30 天的。沉睡想法问一句要不要归档或转给科学决策评估。不评估 ROI。"

echo "==> 每周五 18:00 · 记忆维护"
openclaw cron add --name "CEO助理-记忆维护" --cron "0 18 * * 5" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "记忆维护：读本周 memory/YYYY-MM-DD.md，把稳定偏好折进 USER.md 的 Directives（就地废止旧条目），把耐久事实与决策折进 MEMORY.md，删除过期条目。控制 MEMORY.md 在 2KB 内。"

echo "==> 每日 20:00 · 未闭环任务扫描"
openclaw cron add --name "CEO助理-未闭环扫描" --cron "0 20 * * *" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "扫描今天交代过但没有明确反馈结果的任务。有未闭环的就补一次交付或说明阻塞；全部闭环则回 HEARTBEAT_OK。"

echo "完成。查看：openclaw cron list --agent ceo-assistant"
