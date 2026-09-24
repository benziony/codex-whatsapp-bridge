# Operations

Run `npm run doctor` after setup, Hermes/Codex upgrades, or host changes.

Deploy from a release directory whose critical files match the reviewed Git
commit, then remove owner write permission from that release. Setup may replace
an installed read-only Hermes plugin copy, but it never makes the release
artifact writable. On a Codex host, confirm the setup plan reports the intended
canonical Codex home, hooks file, gateway repository, and broker path before
using `--apply`.

For the Council vote update, use `scripts/release-council-votes.mjs` from a
clean checkout and provide the full reviewed commit ID. Without `--apply`, it
stages and verifies a commit-addressed read-only release under
`~/.hermes/layered-releases`. With `--apply`, it requires the active config
and client LaunchAgent to point at the same exact old release, then atomically
updates `gateway.repositoryPath`, `gateway.brokerPath`, and the client
LaunchAgent's script and working directory. This makes Hermes invoke the new
broker and makes the combined client use the broker in that same release. It
does not rewrite state or credentials, and it does not change the Hermes
plugin, updates LaunchAgent, or an absent Council relay LaunchAgent.

```sh
ACTIVE_CLIENT_SCRIPT="$(plutil -extract ProgramArguments.1 raw "$HOME/Library/LaunchAgents/com.codex-whatsapp-bridge.client.plist")"
node scripts/release-council-votes.mjs --source=/absolute/path/to/clean/checkout --commit=dda02049cdbb872ea7cad819676a895d911fc4c6
node scripts/release-council-votes.mjs --source=/absolute/path/to/clean/checkout --commit=dda02049cdbb872ea7cad819676a895d911fc4c6 --expected-active="$ACTIVE_CLIENT_SCRIPT" --apply
```

The release is identified by PR #19's full merge commit and carries a manifest
of tracked Git blob IDs, Git modes, and SHA-256 hashes. Existing releases are
verified and never overwritten. Activation takes an exclusive lock, captures
the prior broker health, ignores a pre-existing Codex hook-trust warning, and
requires the candidate broker health payload and loaded client service to
match the expected host. A failure restores both the previous config and client
plist and reloads the prior service. Backups are stored beside their originals
with the same timestamp suffix. If the command is interrupted and leaves the
activation lock, do not delete it casually or start another release. First
confirm no release helper is running, then identify the matching config/plist
backup pair by their identical suffix. Inspect both backups before restoring:
the config must point `gateway.repositoryPath` and `gateway.brokerPath` at the
same prior release, and the plist must point its client entry and
`WorkingDirectory` at that same release. If there is no single matching pair
or either backup is malformed, stop and investigate instead of guessing.

For a verified pair, restore it as one operator-controlled rollback. Set the
four paths below to the exact files inspected above; do not use wildcards or
`latest` symlinks. Keep the activation lock until the old service is loaded and
both health checks pass.

```sh
set -euo pipefail
CONFIG="$HOME/.config/codex-whatsapp-bridge/config.json"
PLIST="$HOME/Library/LaunchAgents/com.codex-whatsapp-bridge.client.plist"
CONFIG_BACKUP="/exact/config.json.backup-TIMESTAMP"
PLIST_BACKUP="/exact/com.codex-whatsapp-bridge.client.plist.backup-TIMESTAMP"
RELEASE_ROOT="$HOME/.hermes/layered-releases"
LOCK="$RELEASE_ROOT/.codex-whatsapp-vote-release.lock"
SERVICE="gui/$(id -u)/com.codex-whatsapp-bridge.client"
DOMAIN="gui/$(id -u)"
NODE="$(plutil -extract ProgramArguments.0 raw "$PLIST_BACKUP")"
CONFIG_ROOT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gateway"]["repositoryPath"])' "$CONFIG_BACKUP")"
CONFIG_BROKER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gateway"]["brokerPath"])' "$CONFIG_BACKUP")"
PLIST_ROOT="$(plutil -extract WorkingDirectory raw "$PLIST_BACKUP")"
OLD_CLIENT="$(plutil -extract ProgramArguments.1 raw "$PLIST_BACKUP")"
OLD_BROKER="$CONFIG_BROKER"

plutil -lint "$PLIST_BACKUP"
python3 -m json.tool "$CONFIG_BACKUP" >/dev/null
test "$CONFIG_ROOT" = "$PLIST_ROOT"
test "$OLD_CLIENT" = "$CONFIG_ROOT/scripts/codex-whatsapp-client.mjs"
test "$OLD_BROKER" = "$CONFIG_ROOT/scripts/codex-whatsapp-broker.mjs"
cat "$LOCK"
# Read the lock PID above and verify it is no longer running before continuing.
# Inspect `pgrep -fl '[r]elease-council-votes.mjs'` as a second process check.
launchctl bootout "$SERVICE" 2>/dev/null || true
cp -p "$CONFIG_BACKUP" "$CONFIG.recovery.tmp"
cp -p "$PLIST_BACKUP" "$PLIST.recovery.tmp"
mv "$CONFIG.recovery.tmp" "$CONFIG"
mv "$PLIST.recovery.tmp" "$PLIST"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gateway"]["repositoryPath"])' "$CONFIG")" = "$CONFIG_ROOT"
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gateway"]["brokerPath"])' "$CONFIG")" = "$OLD_BROKER"
test "$(plutil -extract WorkingDirectory raw "$PLIST")" = "$CONFIG_ROOT"
test "$(plutil -extract ProgramArguments.1 raw "$PLIST")" = "$OLD_CLIENT"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl print "$SERVICE"
"$NODE" "$OLD_CLIENT" status | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d.get("broker") or {}; assert d.get("hostId")=="server-mac" and b.get("ok") is True and b.get("status")=="ok" and b.get("transportRoute")=="local"'
printf '%s\n' '{"originHost":"server-mac"}' | "$NODE" "$OLD_BROKER" status | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("status")=="ok"'
```

The checks require `hostId: server-mac`, a healthy local client broker, and a
healthy direct broker. Only after those checks pass, and after confirming the lock still
contains the same transaction ID you inspected before restoration, may this
exact lock path be removed with `rm "$LOCK"`. Never remove the recovery guard
or any other lock by wildcard. If health does not pass, retain the lock and
backups and escalate for investigation.

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
