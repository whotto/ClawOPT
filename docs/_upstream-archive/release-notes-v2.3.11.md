# v2.3.11

- Prevent chat history reconciliation from treating old assistant messages as the current run result when the pre-run history baseline could not be read.
- Apply the same guarded history baseline behavior to single-chat, regenerate, and group-chat runs.
