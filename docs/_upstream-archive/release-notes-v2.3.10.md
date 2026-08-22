# OpenClaw Chat Gateway v2.3.10

- 修复单聊完成探测在读取 OpenClaw 历史时可能回捞本轮之前 assistant 回复的问题。
- 保证带“执行工作”标签的回复在 SSE、OpenClaw 历史、SQLite 和历史接口之间收敛到同一条终态文本。
