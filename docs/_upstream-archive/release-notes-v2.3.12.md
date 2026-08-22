# v2.3.12

- Removed the global per-session `session.prompt` runtime path so individual agents are driven by their workspace markdown context files.
- Improved image-generation routing so agent bootstrap files can steer image intent without hard-coded agent IDs.
- Reduced single-chat latency by avoiding blocking `chat.history` calls before sends and by finalizing from terminal stream events when available.
- Kept failed or unavailable image generation from collapsing the conversation into an empty-run error path.
