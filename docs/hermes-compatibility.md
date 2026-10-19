# Hermes compatibility

Hermes remains the sole WhatsApp transport and keeps its bundled Baileys
adapter. This companion requires two generic Hermes capabilities:

1. an exact-chat, fail-closed external-plugin admission seam;
2. the normalized platform reaction contract used for delayed 👍 receipts.

The admission seam is proposed in
[Hermes PR #98932](https://github.com/NousResearch/hermes-agent/pull/98932).

For bridge v0.1, the reviewed compatibility base is current Hermes commit
`4f22543509d1b91dc45bcb369447126c5eb14fb7`. When the capabilities are not
already present, setup requires that exact clean checkout, verifies
`patches/hermes-compat.patch` with `git apply --check`, applies it before
enabling the dedicated-chat claim, and automatically reverses it if any later
setup step fails.

The patch does not add another WhatsApp process, session, or adapter. It adds
the generic seam and reaction contract to upstream Hermes files. Once both
capabilities ship upstream, setup detects them and skips the compatibility
patch.

Do not force the patch onto another revision. Upgrade the bridge to a release
that explicitly supports the newer Hermes revision, then rerun its dry-run and
tests.

## Compact native polls on the current generic seam

The standalone poll-layout upgrader adds an explicit `context: null` request
to Hermes' existing `/send-poll` endpoint. That request sends one native poll
without a separate context message. Existing nonempty string contexts keep
their two-message behavior and original delivery-key fingerprint. Durable
ledger records mark compact polls with `contextOmitted: true`, so a restart or
late send completion can return the original poll ID without resending. The
send helper also passes the returned poll creation message to Hermes' existing
in-memory message store on normal or late completion, preserving native vote
recognition without adding poll secrets to the durable ledger.

The same generic seam accepts `singleMessage: true` on `/send` for a nonempty
string of at most 8,000 characters. This opt-in sends that text as one
WhatsApp message, so the compact suggestion's text and poll occupy two
messages. Missing or false `singleMessage` keeps Hermes' ordinary text
splitting behavior; malformed or oversized opt-in requests return HTTP 400.

On the gateway Mac, first run `node scripts/upgrade-hermes-poll-layout.mjs`
from this repository. It reads `gateway.hermesCheckout` from the private bridge
config and reports the original and candidate SHA-256 hashes without changing
the Hermes file. An alternate exact source can be supplied with
`--bridge=/absolute/path/to/bridge.js`; `--config=/absolute/path/to/config.json`
selects the private backup root. Inspect the dry-run result before running
`node scripts/upgrade-hermes-poll-layout.mjs --apply` with the same options.
Apply rechecks the source hash, keeps a mode-0600 original in the config's
mode-0700 `backups` directory, and atomically replaces only the recognized
generic bridge source. It does not restart Hermes or change a WhatsApp session.

The upgraded source retains `native-polls-ledger-v1`, adds
`compact-polls-v1`, and reports `compactPolls: true` in `/health`. A running
gateway must be restarted and its fresh health response checked before a
caller sends compact polls. Unknown or partially modified source is refused;
restore the reported backup only after checking its hash and the intended
active source. This upgrade does not modify the bundled WhatsApp adapter.
