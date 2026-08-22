# OpenClaw Chat Gateway v2.3.15

- Fix OpenClaw update verification so gateway restart recovery is polled instead of failing on the first unhealthy probe.
- Increase OpenClaw chat startup/history wait windows to avoid false `chat.send timeout` failures when the gateway is slow or queued but the run later succeeds.
