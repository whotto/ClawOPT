#!/usr/bin/env bash
# 情报调研 — 推荐定时任务（一次性执行即可全部创建）
set -euo pipefail
TZ_ARG="--tz Asia/Shanghai"
AGENT="--agent intel-research"
# 非默认 Agent 只能用 isolated 会话：sessionTarget "main" 仅对默认 Agent 有效，
# 对其他 Agent 会被 Gateway 直接拒绝（invalid cron.add params）。
SESSION="--session isolated"
# 没绑消息渠道时用 --no-deliver，否则每次投递都会 fail-closed 刷日志。
# 绑好渠道之后换成：DELIVERY="--announce --channel <channel> --to <dest>"
DELIVERY="--no-deliver"

echo "==> 每周二 10:00 · 信息缺口跟进"
openclaw cron add --name "情报调研-缺口跟进" --cron "0 10 * * 2" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "读 MEMORY.md 的信息缺口清单，挑 1-2 条尝试新的搜索路径或替代渠道。有进展就告诉搭档；没有就更新已尝试渠道后回 HEARTBEAT_OK。不编造。"

echo "==> 每周一 09:00 · 赛道动态扫描"
openclaw cron add --name "情报调研-赛道扫描" --cron "0 9 * * 1" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "扫描搭档关注赛道的上周重大动态（政策/融资/竞品/数据更新）。只报有实质变化的，每条带来源+年份+可信度。没有实质变化就回 HEARTBEAT_OK。"

echo "==> 每月 1 日 10:00 · 信源可信度校准"
openclaw cron add --name "情报调研-信源校准" --cron "0 10 1 * *" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "复盘本月用过的信源：哪些后来被验证靠谱、哪些翻过车。更新 MEMORY.md 的可信度校准记录。"

echo "==> 每周五 18:00 · 记忆维护"
openclaw cron add --name "情报调研-记忆维护" --cron "0 18 * * 5" $TZ_ARG $AGENT $SESSION $DELIVERY \
  --message "记忆维护：读本周 memory/YYYY-MM-DD.md，稳定偏好折进 USER.md 的 Directives（就地废止旧条目），业务背景与信源校准折进 MEMORY.md。"

echo "完成。查看：openclaw cron list --agent intel-research"
