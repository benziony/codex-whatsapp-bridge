# Operations

Run `npm run doctor` after setup, Hermes/Codex upgrades, or host changes.

Deploy from a release directory whose critical files match the reviewed Git
commit, then remove owner write permission from that release. Setup may replace
an installed read-only Hermes plugin copy, but it never makes the release
artifact writable. On a Codex host, confirm the setup plan reports the intended
canonical Codex home, hooks file, gateway repository, and broker path before
using `--apply`.

Production validation should cover:

1. mirrored final and optional progress messages;
2. quoted text returning to the exact task;
3. unquoted text creating a new task;
4. unquoted and quoted voice notes;
5. image, PDF, and another arbitrary attachment;
6. unknown/expired quote visible failure without new-task fallback;
7. unauthorized sender and unrelated chat/poll isolation;
8. native Council poll delivery/retry, exact poll registration, and owner-only vote interception;
9. busy-task FIFO queuing and restart replay;
10. 👍 after App Server acceptance, plus reaction retry after bridge restart;
11. weekly update notification deduplication.

Setup stores timestamped backups under
`~/.config/codex-whatsapp-bridge/backups`. Restore the most recent backup and
reload the affected LaunchAgent/Hermes process to roll back. Backups include
the active hooks file, a distinct legacy hooks file when one exists, runtime
configuration, installed plugin, and affected LaunchAgent definitions.
