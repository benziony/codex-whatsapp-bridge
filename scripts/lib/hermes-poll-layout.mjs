// Exact, fail-closed upgrade of the generic Hermes poll seam. This module has
// no filesystem or runtime side effects.
export const COMPACT_POLLS_MARKER = 'compact-polls-v1';
export const POLL_VOTER_IDENTITY_MARKER = 'poll-voter-identity-v1';

const changes = [
  [
    "const CODEX_WHATSAPP_BRIDGE_CAPABILITIES = 'native-polls-ledger-v1';",
    "const CODEX_WHATSAPP_BRIDGE_CAPABILITIES = 'native-polls-ledger-v1 compact-polls-v1';",
  ],
  [
    "sendPromise.then((result) => { try { onResolved(result); } catch (error) { console.warn('[bridge] failed to persist late poll result:', error.message); } }, () => {});",
    "sendPromise.then((result) => { try { rememberSentMessage(result, payload); } catch (error) { console.warn('[bridge] failed to cache poll creation:', error.message); } try { onResolved(result); } catch (error) { console.warn('[bridge] failed to persist late poll result:', error.message); } }, () => {});",
  ],
  [
    "  const { chatId, message, replyTo } = req.body;\n  if (!chatId || !message) {\n    return res.status(400).json({ error: 'chatId and message are required' });\n  }",
    "  const { chatId, message, replyTo, singleMessage = false } = req.body;\n  if (!chatId || !message) {\n    return res.status(400).json({ error: 'chatId and message are required' });\n  }\n  if (typeof singleMessage !== 'boolean' || (singleMessage && (typeof message !== 'string' || !message.length || message.length > 8000))) {\n    return res.status(400).json({ error: 'Invalid singleMessage payload' });\n  }",
  ],
  [
    "  try {\n    const chunks = splitLongMessage(formatOutgoingMessage(message));\n    const messageIds = [];",
    "  try {\n    const chunks = singleMessage ? [formatOutgoingMessage(message)] : splitLongMessage(formatOutgoingMessage(message));\n    const messageIds = [];",
  ],
  [
    "if (item.phase === 'context-sent' || item.phase === 'poll-pending') return validId(item.contextMessageId) && !item.pollMessageId;\n    if (item.phase === 'complete') return validId(item.contextMessageId) && validId(item.pollMessageId);",
    "if (item.phase === 'context-sent') return validId(item.contextMessageId) && !item.pollMessageId && item.contextOmitted !== true;\n    if (item.phase === 'poll-pending') return (item.contextOmitted === true ? !item.contextMessageId : validId(item.contextMessageId)) && !item.pollMessageId;\n    if (item.phase === 'complete') return (item.contextOmitted === true ? !item.contextMessageId : validId(item.contextMessageId)) && validId(item.pollMessageId);",
  ],
  [
    "typeof context !== 'string' || context.length < 1 || context.length > 1200",
    "(context !== null && (typeof context !== 'string' || context.length < 1 || context.length > 1200))",
  ],
  [
    "    if (!contextMessageId) {\n      const createdAt = Date.now();",
    "    if (!contextMessageId && context !== null) {\n      const createdAt = Date.now();",
  ],
  [
    "phase: 'poll-pending', contextMessageId, createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS",
    "phase: 'poll-pending', contextMessageId, ...(context === null ? { contextOmitted: true } : {}), createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS",
  ],
  [
    "phase: 'complete', contextMessageId, pollMessageId, createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS",
    "phase: 'complete', contextMessageId, pollMessageId, ...(context === null ? { contextOmitted: true } : {}), createdAt, expiresAt: createdAt + POLL_LEDGER_TTL_MS",
  ],
  [
    "const result = { success: true, pollMessageId, messageIds: [contextMessageId, pollMessageId] };",
    "const result = { success: true, pollMessageId, messageIds: [contextMessageId, pollMessageId].filter(Boolean) };",
  ],
  [
    "    sendReadReceipts: SEND_READ_RECEIPTS,\n  });\n});",
    "    sendReadReceipts: SEND_READ_RECEIPTS,\n    compactPolls: true,\n  });\n});",
  ],
];

const voterIdentityChanges = [
  [
    "const CODEX_WHATSAPP_BRIDGE_CAPABILITIES = 'native-polls-ledger-v1 compact-polls-v1';",
    "const CODEX_WHATSAPP_BRIDGE_CAPABILITIES = 'native-polls-ledger-v1 compact-polls-v1 poll-voter-identity-v1';",
  ],
  [
    "  const chatId = normalizeWhatsAppId(key?.remoteJid || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.remoteJid || '');\n  const senderId = normalizeWhatsAppId(\n    key?.participant\n    || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.participant\n    || chatId\n  );\n  const pollId = key?.id\n    || update?.pollUpdates?.[0]?.pollCreationMessageKey?.id\n    || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.id\n    || '';",
    "  const pollUpdates = update?.pollUpdates;\n  // One event must describe one voter's selected options. Mixed batches are\n  // ambiguous and must not be assigned to the first voter.\n  if (!Array.isArray(pollUpdates) || pollUpdates.length !== 1) return;\n  const voterKey = pollUpdates[0]?.pollUpdateMessageKey;\n  const chatId = normalizeWhatsAppId(key?.remoteJid || voterKey?.remoteJid || '');\n  const senderId = normalizeWhatsAppId(voterKey?.participant || (voterKey?.fromMe === true ? sock?.user?.id : ''));\n  if (!chatId || !senderId) return;\n  const pollId = key?.id || pollUpdates[0]?.pollCreationMessageKey?.id || '';",
  ],
  [
    "  sock.ev.on('messages.update', async (updates) => {\n    for (const { key, update } of updates || []) {\n      if (!update?.pollUpdates) continue;",
    "  sock.ev.on('messages.update', async (updates) => {\n    for (const { key, update: combinedUpdate } of updates || []) {\n      if (!Array.isArray(combinedUpdate?.pollUpdates)) continue;\n      for (const voteUpdate of combinedUpdate.pollUpdates) {\n        const update = { ...combinedUpdate, pollUpdates: [voteUpdate] };",
  ],
  [
    "      enqueuePollUpdateEvent({ key, update: { ...update, pollUpdates }, selectedOptions, aggregation });\n    }\n  });",
    "      enqueuePollUpdateEvent({ key, update: { ...update, pollUpdates }, selectedOptions, aggregation });\n      }\n    }\n  });",
  ],
  [
    "    compactPolls: true,\n  });\n});",
    "    compactPolls: true,\n    pollVoterIdentity: true,\n  });\n});",
  ],
];

function occurrences(source, snippet) {
  return source.split(snippet).length - 1;
}

export function upgradeHermesPollLayout(source) {
  if (typeof source !== 'string' || !source.includes("app.post('/send', async (req, res) => {") || !source.includes("app.post('/send-poll', async (req, res) => {") || !source.includes("app.get('/health', (req, res) => {") || !source.includes('function loadPollLedger()')) {
    throw new Error('Unrecognized Hermes poll seam');
  }
  const patched = source.includes(COMPACT_POLLS_MARKER);
  const voterPatched = source.includes(POLL_VOTER_IDENTITY_MARKER);
  if (voterPatched && !patched) throw new Error('Hermes voter identity marker without compact poll seam');
  let baseSource = source;
  if (voterPatched) {
    for (const [before, after] of voterIdentityChanges) {
      if (occurrences(baseSource, after) !== 1 || (!after.includes(before) && occurrences(baseSource, before) !== 0)) {
        throw new Error('Hermes poll voter identity seam differs from the reviewed layout or is partially patched');
      }
      baseSource = baseSource.replace(after, before);
    }
  }
  for (const [before, after] of changes) {
    const oppositeOverlaps = patched && after.includes(before);
    if (occurrences(baseSource, patched ? after : before) !== 1 || (!oppositeOverlaps && occurrences(baseSource, patched ? before : after) !== 0)) {
      throw new Error('Hermes poll seam differs from the reviewed layout or is partially patched');
    }
  }
  let result = baseSource;
  if (!patched) for (const [before, after] of changes) result = result.replace(before, after);
  for (const [index, [before, after]] of voterIdentityChanges.entries()) {
    if (occurrences(result, before) !== 1 || occurrences(result, after) !== 0) {
      throw new Error(`Hermes poll voter identity seam differs from the reviewed layout or is partially patched at anchor ${index}`);
    }
  }
  for (const [before, after] of voterIdentityChanges) result = result.replace(before, after);
  return { source: voterPatched ? source : result, status: voterPatched ? 'already-patched' : 'upgrade-available' };
}
