# Operations

Run `npm run doctor` after setup, Hermes/Codex upgrades, or host changes.

Production validation should cover:

1. mirrored final and optional progress messages;
2. quoted text returning to the exact task;
3. unquoted text creating a new task;
4. unquoted and quoted voice notes;
5. image, PDF, and another arbitrary attachment;
6. unknown/expired quote visible failure without new-task fallback;
7. unauthorized sender and unrelated chat/poll isolation;
8. busy-task FIFO queuing and restart replay;
9. 👍 after App Server acceptance, plus reaction retry after bridge restart;
10. weekly update notification deduplication.

Setup stores timestamped backups under
`~/.config/codex-whatsapp-bridge/backups`. Restore the most recent backup and
reload the affected LaunchAgent/Hermes process to roll back.

