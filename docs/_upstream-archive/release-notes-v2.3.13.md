# v2.3.13

- Restored OpenClaw-backed history baselines before chat sends to prevent finalization from picking up a previous assistant response.
- Restored the normal streamed completion reconciliation path after `chat.final`, preserving delta updates and final history validation.
