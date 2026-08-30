# Security

- The dedicated chat is an exact core-configured claim. Plugin absence,
  collision, load failure, callback error, or broker rejection never falls
  through to the Hermes agent loop.
- Admission requires Hermes transport-profile authorization and the plugin's
  narrower exact sender allowlist.
- Runtime files use `0700` directories and `0600` files.
- Attachment inputs must be regular non-symlink files below approved Hermes
  cache roots. Limits are 10 files and 128 MiB total; staged copies are hashed.
- The broker is a local process. Split installations use existing BatchMode
  SSH/SCP; this project opens no public listener.
- WhatsApp session/auth state, Codex databases, credentials, and browser
  profiles are never copied or committed.
- Progress mirroring filters common secret, token, credential, and one-time
  code patterns. The full progress log remains in Codex when omitted.
- Weekly update checks send only the available Git commit identity and never
  pull, install, restart, or execute remote code.

Report security issues privately to the repository owner until a public
security contact is configured.

