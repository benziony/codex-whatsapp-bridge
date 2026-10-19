// Exact, fail-closed upgrade of the generic Hermes poll seam. This module has
// no filesystem or runtime side effects.
export const COMPACT_POLLS_MARKER = 'compact-polls-v1';

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

function occurrences(source, snippet) {
  return source.split(snippet).length - 1;
}

export function upgradeHermesPollLayout(source) {
  if (typeof source !== 'string' || !source.includes("app.post('/send', async (req, res) => {") || !source.includes("app.post('/send-poll', async (req, res) => {") || !source.includes("app.get('/health', (req, res) => {") || !source.includes('function loadPollLedger()')) {
    throw new Error('Unrecognized Hermes poll seam');
  }
  const patched = source.includes(COMPACT_POLLS_MARKER);
  for (const [before, after] of changes) {
    const oppositeOverlaps = patched && after.includes(before);
    if (occurrences(source, patched ? after : before) !== 1 || (!oppositeOverlaps && occurrences(source, patched ? before : after) !== 0)) {
      throw new Error('Hermes poll seam differs from the reviewed layout or is partially patched');
    }
  }
  if (patched) return { source, status: 'already-patched' };
  let result = source;
  for (const [before, after] of changes) result = result.replace(before, after);
  return { source: result, status: 'upgrade-available' };
}
