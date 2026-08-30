# Codex ↔ WhatsApp Bridge

Your self-hosted Codex inbox in WhatsApp.

Codex ↔ WhatsApp Bridge mirrors completed Codex turns into one dedicated
WhatsApp chat and routes replies back to the exact Codex task. Unquoted
messages create new Codex tasks. It supports text, voice notes, images, and
arbitrary WhatsApp attachments, with 👍 only after Codex accepts a delivery.

Hermes continues to own WhatsApp connectivity. This project is an external
Hermes plugin plus a small generic upstream interception seam; it does not
replace or fork Hermes' bundled WhatsApp adapter.

The seam is proposed upstream in
[Hermes PR #98932](https://github.com/NousResearch/hermes-agent/pull/98932).
Until that and the required reaction contract land, setup applies one reviewed,
version-pinned compatibility patch only to the exact supported current Hermes
commit. It refuses dirty, older, newer, or mismatched checkouts instead of
installing a shadow WhatsApp implementation.

## What it does

- Mirrors `Project · task` finals to WhatsApp.
- Optionally mirrors Codex's visible progress updates before the final.
- Routes a quoted WhatsApp reply to the exact mirrored Codex task.
- Creates a new Codex task for an unquoted message or voice note.
- Transcribes voice notes with the warning prefix
  `Voice note transcription (may contain errors):`.
- Stages arbitrary attachments with bounded count, size, path, and SHA-256
  validation.
- Preserves FIFO ordering and deduplicates retries.
- Reacts 👍 only after the Codex App Server accepts the turn.
- Checks weekly for repository updates and notifies in WhatsApp; it never
  auto-updates.

Unknown or expired quotes fail visibly and never fall back to a new task.
Polls and unrelated Hermes/WhatsApp traffic stay on stock Hermes.

## Topologies

- `combined`: Hermes and Codex run on one Mac.
- `gateway`: this Mac runs Hermes/WhatsApp; a second Mac runs Codex.
- `codex`: this Mac runs Codex and reaches the gateway broker over SSH.

Both Macs use the same repository version and their own reviewed config. Live
Hermes/Codex state is never synchronized between them.

## Install with Codex

Clone this repository and tell Codex:

> Read this repository's AGENTS.md and install Codex WhatsApp Bridge. Inspect
> my topology first, show me the dry-run configuration and tests, and wait for
> approval before applying it.

Manual entry point:

```bash
npm test
npm run check
npm run setup
npm run setup:apply
npm run doctor
```

Hermes must already be installed with its Python environment and WhatsApp
session on the gateway Mac. On the currently supported release, use Hermes
commit `4f22543509d1b91dc45bcb369447126c5eb14fb7`; setup verifies this before
changing runtime configuration. See
[Hermes compatibility](docs/hermes-compatibility.md).

Setup asks whether progress updates should be mirrored. Finals-only is the
default. See [configuration](docs/configuration.md),
[architecture](docs/architecture.md), [security](docs/security.md), and
[operations](docs/operations.md).

## Boundaries

- Incoming WhatsApp text is ordinary user input, never a native Codex
  permission bypass.
- Codex may still require its own UI for credentials, destructive or
  irreversible operations, or native tool approvals.
- v0.1 is macOS-first and uses Codex App Server because it preserves exact
  Desktop task identity, streamed progress, queuing, and image inputs.
