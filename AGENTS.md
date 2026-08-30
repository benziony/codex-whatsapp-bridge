# Codex WhatsApp Bridge installer guidance

This repository is designed to be installed by Codex on the user's Mac. Read
`README.md`, `docs/architecture.md`, `docs/configuration.md`, and
`docs/security.md` before changing or installing runtime behavior.

When a user asks to install:

1. Inspect whether Hermes and Codex run on the same Mac or separate Macs.
2. Run `npm test`, `npm run check`, and `npm run setup` as a dry run.
3. Show the exact derived configuration, file changes, backup location, and
   validation plan. Wait for approval before `npm run setup:apply`.
4. Never copy Hermes credentials, WhatsApp sessions, Codex databases, browser
   profiles, or secrets into this repository or between Macs.
5. Keep Hermes' bundled WhatsApp adapter. Install the external plugin and the
   smallest compatible generic Hermes seam; never replace the adapter.
6. Verify text, quoted reply, new task, voice, image, arbitrary attachment,
   unknown quote, unauthorized sender, unrelated poll/chat, delayed reaction,
   restart replay, and rollback behavior before claiming production success.
7. Do not publish personal JIDs, hostnames, paths, task IDs, routes, messages,
   transcripts, or runtime configuration.

Installation is macOS-first. Do not claim native Windows/Linux support or
WhatsApp approval of native Codex permission prompts.

