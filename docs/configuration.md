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
  "codex": {
    "binary": "/opt/homebrew/bin/codex",
    "defaultCwd": "/absolute/project/or/inbox/directory",
    "mirrorProgress": false
  },
  "codexInbox": {
    "originHost": "my-mac",
    "cwd": "/absolute/project/or/inbox/directory"
  }
}
```

For split topology the gateway configures `codexInbox.originHost` and the
absolute new-task directory on the Codex Mac. The Codex host configures
`gateway.sshHost`, the gateway's `repositoryPath`, gateway-side Node binary,
`brokerPath`, and exact `attachmentPath`. Optional
`lanHost` plus `hostKeyAlias` provides a pinned LAN fallback. SSH must already
work non-interactively; setup does not install keys or weaken host checking.
Bridge repository, Node, and split-host attachment paths must be absolute and
contain no whitespace because OpenSSH reconstructs the remote broker command.
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

Setup also makes the exact dedicated group reachable under Hermes' normal
group intake rules and exempts only that group from mention requirements. It
preserves an existing open group policy and unions existing group/free-response
lists.
