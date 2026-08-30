# Architecture

```text
WhatsApp
  │
  ▼
Hermes bundled WhatsApp adapter
  │ normalized MessageEvent, before debounce/busy merging
  ▼
core-configured exact-chat exclusive claim
  │ Hermes auth + plugin sender allowlist
  ▼
external Codex WhatsApp plugin
  │ bounded STT / attachment validation
  ▼
durable broker state ── SSH when split ── Codex client
  │                                      │
  │                                      ▼
  └──────── WhatsApp messages ◀── Codex App Server
                  ▲                    │
                  └──── delayed 👍 ────┘
```

The Hermes core seam is generic. Core configuration owns one exact chat claim,
Hermes owns transport-profile authorization, and the plugin must durably admit
each normalized message before returning success. Missing plugins, duplicate
registrations, callback failures, and malformed claim configuration fail
closed. Poll updates bypass the claim.

The broker stores routes, inbound deliveries, leases, notification attempts,
receipt attempts, and attachment digests atomically. A quoted reply matches the
digest of one known mirrored WhatsApp message. An unquoted message is queued as
a new task for the configured Codex host and working directory. FIFO sequence
numbers and per-task claims prevent concurrent reordering.

Combined topology uses the broker locally. Split topology invokes the same
broker over BatchMode SSH and copies staged attachments with SCP, then verifies
size and SHA-256 before showing paths to Codex.

