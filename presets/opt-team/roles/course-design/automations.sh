#!/usr/bin/env bash
# 课程设计（外·AI 落地课程设计）— 推荐定时任务（一次性执行即可全部创建）
set -euo pipefail
TZ_ARG="--tz Asia/Shanghai"
SESSION="--session main"

echo "==> 每周一 09:00 · 课程趋势监测"
openclaw automations add --name "课程设计-课程趋势监测" --cron "0 9 * * 1" $TZ_ARG $SESSION \
  --system-event "搜索 AI 落地培训/企业 AI 实战课的最新案例与方法（近 30 天）。只报有实质增量的，每条带来源和日期，追加到 memory/courses/trends.md。没有增量就回 HEARTBEAT_OK。"

echo "==> 每周四 09:00 · AI 工具生态追踪（含版本核实）"
openclaw automations add --name "课程设计-工具生态追踪" --cron "0 9 * * 4" $TZ_ARG $SESSION \
  --system-event "联网核实课程材料里用到的 AI 工具/模型的当前版本与能力边界（不要用训练知识）。有变化就更新 MEMORY.md 的『工具与模型版本核实记录』，并指出哪些课程物料需要同步修订。"

echo "==> 每两周周五 15:00 · 学员反馈收集"
openclaw automations add --name "课程设计-反馈收集" --cron "0 15 */14 * *" $TZ_ARG $SESSION \
  --system-event "主动问{{USER_TITLE}}：最近交付的课程实际效果如何？学员反馈里有哪些需要调整的？把回答写进 MEMORY.md 的历史课程设计与反馈结果。"

echo "==> 每月 1 日 10:00 · 课程质量复盘"
openclaw automations add --name "课程设计-月度复盘" --cron "0 10 1 * *" $TZ_ARG $SESSION \
  --system-event "月度复盘：本月交付了哪些课程包、哪些被实际使用、哪些被{{USER_TITLE}}改动过、改动说明了什么设计问题。把可复用的模块和模板沉淀到 memory/courses/ 和 templates/。"

echo "==> 每周五 18:00 · 记忆维护"
openclaw automations add --name "课程设计-记忆维护" --cron "0 18 * * 5" $TZ_ARG $SESSION \
  --system-event "记忆维护：读本周 memory/YYYY-MM-DD.md，稳定偏好折进 USER.md 的 Directives（就地废止旧条目），课程资产与反馈折进 MEMORY.md。"

echo "完成。查看：openclaw automations list"
