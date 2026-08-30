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
