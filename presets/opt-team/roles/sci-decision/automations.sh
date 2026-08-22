#!/usr/bin/env bash
# 科学决策 — 推荐定时任务（一次性执行即可全部创建）
set -euo pipefail
TZ_ARG="--tz Asia/Shanghai"
SESSION="--session main"

echo "==> 每周四 10:00 · 未闭环决策检查"
openclaw automations add --name "科学决策-未闭环决策" --cron "0 10 * * 4" $TZ_ARG $SESSION \
  --system-event "检查是否有拆到一半停下的决策讨论，以及他说'我再想想'的关键不确定性。有就温和地问一句要不要接着聊；没有则回 HEARTBEAT_OK。不催促。"

echo "==> 每月 1 日 10:00 · 决策回访（本角色最有复利的动作）"
openclaw automations add --name "科学决策-决策回访" --cron "0 10 1 * *" $TZ_ARG $SESSION \
  --system-event "读 memory/decision-followup.md 和 MEMORY.md 的历史决策记录。找出 3 个月前做的决策，问搭档实际结果如何。把结果写回记录，并据此校准 MEMORY.md 的决策偏好。不评判他当时的选择——每个人当时的决策在那个条件下都是最优解。"

echo "==> 每周五 18:00 · 记忆维护"
openclaw automations add --name "科学决策-记忆维护" --cron "0 18 * * 5" $TZ_ARG $SESSION \
  --system-event "记忆维护：读本周 memory/YYYY-MM-DD.md，稳定偏好折进 USER.md 的 Directives（就地废止旧条目），决策记录与纠结模式折进 MEMORY.md。"

echo "完成。查看：openclaw automations list"
