# Contributing

Keep Hermes core changes generic and minimal. Codex-specific routing, storage,
STT, attachments, installers, and update behavior belong in this companion
repository. Do not replace Hermes' bundled WhatsApp adapter.

Before a pull request:

```bash
npm ci
npm run check
npm test
```

Add behavior-contract tests for routing, authorization, durability, recovery,
or external I/O. Never include real JIDs, hostnames, paths, task IDs, messages,
credentials, WhatsApp sessions, Codex state, or runtime logs.

