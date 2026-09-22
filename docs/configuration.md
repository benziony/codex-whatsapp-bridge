# Configuration

Runtime configuration is stored at
`~/.config/codex-whatsapp-bridge/config.json` with mode `0600`; its parent is
`0700`. It is never committed.

```json
{
  "schemaVersion": 1,
  "role": "combined",
  "hostId": "my-mac",
  "gateway": {
    "repositoryPath": "/absolute/path/to/codex-whatsapp-bridge",
    "brokerPath": "/absolute/path/to/codex-whatsapp-bridge/scripts/codex-whatsapp-broker.mjs",
    "hermesCheckout": "/absolute/path/to/hermes-agent",
    "hermesPython": "/absolute/path/to/hermes-venv/bin/python",
    "node": "/opt/homebrew/opt/node@24/bin/node"
  },
  "whatsapp": {
    "chatId": "1234567890-1234567890@g.us",
    "allowedSenders": ["15551234567@s.whatsapp.net"],
    "bridgeUrl": "http://127.0.0.1:3000",
    "attachmentSourceRoots": ["/absolute/hermes/media/cache"]
  },
  "councilApprovals": {
    "chatId": "2345678901-2345678901@g.us",
    "allowedSenders": ["15551234567@s.whatsapp.net"],
    "councilUrl": "https://council.panelsgroup.com",
    "codexCredentialFile": "/absolute/private/codex-council-token",
    "scope": "design",
    "workspace": "default",
    "nativePolls": true
  },
  "councilPush": {
    "enabled": true,
    "councilUrl": "https://council.panelsgroup.com",
    "codexCredentialFile": "/absolute/private/codex-council-token",
    "workspace": "default",
    "cwd": "/absolute/project/or/inbox/directory"
  },
  "codex": {
    "binary": "/opt/homebrew/bin/codex",
    "home": "/absolute/path/to/active/codex/home",
    "defaultCwd": "/absolute/project/or/inbox/directory",
    "mirrorProgress": false
  },
  "codexInbox": {
    "originHost": "my-mac",
    "cwd": "/absolute/project/or/inbox/directory"
  }
}
```

`codex.home` is the canonical active Codex state directory. Setup resolves it
from `--codex-home`, an existing `codex.home`, `CODEX_HOME`, or finally
`~/.codex`, in that order, and resolves an existing symlink before saving it.
Hooks, sessions, and `state_5.sqlite` are always read from this directory, and
Codex-side LaunchAgents receive the same `CODEX_HOME`. When the legacy
`~/.codex` is a different directory, setup removes only this bridge's stale
hook commands there and preserves unrelated hooks.

`councilApprovals` is optional and is deliberately a separate exact-chat
claim. It uses the Codex principal credential reference (`codexCredentialFile`
or `codexTokenEnv`), not an owner credential. When push is also enabled, both
sections must name the same file or environment variable and workspace.
Every permit, decision, and readback request carries that explicit workspace;
the Codex credential never calls the owner-only dashboard. Incoming commands
must be exactly `APPROVE|REJECT case_id REV n DIGEST sha256`. The bridge
reads the exact immutable decision status before every attempt, requires the
exact owner-issued unexpired `whatsappPermit` metadata and opaque permit
reference, then fetches that reference from the exact Codex-authenticated
`GET /api/whatsapp/permit?caseId=...&rev=...&digest=...` route immediately
before the decision. It sends the reference only in the authenticated HTTPS
`POST /api/whatsapp/decision` call.
It never trusts agent-supplied risk or channel fields, and never puts the
permit reference in WhatsApp, prompts, logs, or replay state. Credential
creation, permission broadening, destructive, and financial approvals remain
web-only in Council. Existing Codex Blockers routing remains independent.

`nativePolls` enables the contextual native Approve/Reject poll for Council
permit events. The relay uses a deterministic UUID delivery key, registers the
poll against the exact case, revision, digest, scope, and owner permit, and
accepts votes only from the exact configured Council chat and owner sender.
After a vote POST, the bridge reads back the exact immutable poll decision and
refetches poll status. It shows success only when the poll is consumed and its
poll, case, revision, digest, scope, and verdict all match; retries report the
existing decision without attempting a reversal. If exact consumption cannot
be confirmed, WhatsApp reports an uncertain outcome instead of claiming that
the vote failed or succeeded.
The permit reference never appears in WhatsApp text, poll context, prompts, or
replay state. Set it to `false` to retain the bounded text-command fallback.

`councilPush` is an optional outbound-only Council event consumer for the
Codex-role Mac. It uses a separate Codex-principal credential reference (never
the owner credential), keeps a `0600` replay cursor, reconnects with bounded
backoff, and wakes a fresh Codex task per event by default. An explicit
`sessionId` is supported only for a reviewed task-owned setup. It opens no
inbound Mac port. If an event is explicitly WhatsApp-eligible, the consumer
also sends the bounded native poll or text fallback described above to the
configured Council Approvals chat using a stable delivery key.

If the Council stream returns `410 Gone` because the cursor is older than the
replay floor, the relay calls the authenticated
`GET /api/events/reconcile?since=N&workspace=...` endpoint. Council must return
the flat bounded shape `{latestCursor,replayFloor,pendingProposals,activeJobs,inboxRefs}`.
The relay sends only an allowlisted redacted snapshot to a fresh reconciliation
task and advances the cursor after that task completes; it never silently
resets or discards a cursor.

For split topology the gateway configures `codexInbox.originHost` and the
absolute new-task directory on the Codex Mac. The Codex host configures
`gateway.sshHost`, the gateway's `repositoryPath`, gateway-side Node binary,
and exact `attachmentPath`. `gateway.brokerPath` defaults to the broker inside
that repository, so selecting a new release rolls both paths together. Use the
explicit `--gateway-broker` setup option only for a reviewed pin. Optional
`lanHost` plus `hostKeyAlias` provides a pinned LAN fallback. SSH must already
work non-interactively; setup does not install keys or weaken host checking.
Bridge repository, Node, and split-host attachment paths must be absolute and
use only letters, digits, `/`, `.`, `_`, `-`, `+`, and `@` because OpenSSH
reconstructs the remote broker command through a shell.
`gateway.hermesPython` is optional; when omitted, setup checks
`.venv/bin/python` and `venv/bin/python` inside `gateway.hermesCheckout`.

`codexInbox` is only the destination for new unquoted messages. Quoted replies
always use the originating host and exact task route, so a combined gateway can
target new tasks on the second Mac without losing its own task routing.

An installed role is intentionally immutable in v0.1. Setup refuses a role
change before touching files so hooks, plugins, claims, or LaunchAgents from
the old topology cannot remain active. A topology migration must be reviewed as
an uninstall/reinstall operation with its own rollback.

Hermes receives this reviewed platform setting:

```yaml
gateway:
  platforms:
    whatsapp:
      extra:
        exclusive_inbound:
          chat_id: "1234567890-1234567890@g.us"
          handler: codex_whatsapp_bridge
          allowed_senders:
            - "15551234567@s.whatsapp.net"
```

When Council approvals are enabled, `extra.exclusive_inbound` is a list of
two claims (the normal Codex claim and the Council Approvals claim), each with
its own exact chat and sender allowlist. Older Hermes compatibility patches
that only accept one mapping must be upgraded before applying this setting.

Setup also makes the exact dedicated group reachable under Hermes' normal
group intake rules and exempts only that group from mention requirements. It
preserves an existing open group policy and unions existing group/free-response
lists.
