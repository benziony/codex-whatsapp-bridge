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
