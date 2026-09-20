import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCurrentWhatsappPermit, parseCouncilApproval, processCouncilApproval, processCouncilPollVote } from "../scripts/lib/council-approvals.mjs";

const digest = "a".repeat(64);
const permitId = "wp_opaque_permit_123456";
const permit = (caseId = "case_mu4vrfky_2", rev = 1, scope = "design") => ({ caseId, rev, digest, scope, issuedBy: "owner", issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
const pollStatus = (pollId = "WA.poll-1", status = "active", scope = "design") => ({ registered: true, status, pollId, caseId: "case_mu4vrfky_2", rev: 1, digest, scope, consumedAt: status === "consumed" ? "2026-09-20T12:00:00.000Z" : null });

test("Council command syntax is exact and case/revision/digest are captured", () => {
  assert.deepEqual(parseCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`), {
    verdict: "approved", caseId: "case_mu4vrfky_2", rev: 1, digest,
  });
  assert.equal(parseCouncilApproval(`approve case_mu4vrfky_2 REV 1 DIGEST ${digest}`), null);
  assert.equal(parseCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest} now`), null);
});

test("owner permit is exact, current, and bound to case revision digest and scope", () => {
  assert.equal(isCurrentWhatsappPermit(permit(), { caseId: "case_mu4vrfky_2", rev: 1, digest, scope: "design" }), true);
  assert.equal(isCurrentWhatsappPermit({ ...permit(), issuedBy: "" }), false);
  assert.equal(isCurrentWhatsappPermit({ ...permit(), expiresAt: new Date(Date.now() - 1).toISOString() }), false);
  assert.equal(isCurrentWhatsappPermit({ ...permit(), caseId: "other" }), false);
  assert.equal(isCurrentWhatsappPermit({ ...permit(), extra: "agent supplied" }), false);
});

test("native Council poll vote is exact-chat owner-only and maps to the poll decision route", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  const calls = [];
  let statusCalls = 0;
  const vote = { pollMessageId: "WA.poll-1", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-1" };
  const fetcher = async (url, token, init = {}) => {
    calls.push({ url, token, init });
    if (String(url).includes("/status?")) { statusCalls += 1; return pollStatus("WA.poll-1", statusCalls % 2 === 0 ? "consumed" : "active"); }
    if (String(url).includes("/poll/decision?") && !init.method) return { ...pollStatus("WA.poll-1", "consumed"), verdict: "approved" };
    return { acknowledgement: "Council approved." };
  };
  const result = await processCouncilPollVote(vote, config, { fetcher });
  await processCouncilPollVote(vote, config, { fetcher });
  assert.deepEqual(result, { ok: true, status: "accepted", message: "Council approved." });
  const decisionCalls = calls.filter((call) => call.init.method === "POST");
  assert.match(decisionCalls[0].url, /\/api\/whatsapp\/poll\/decision$/);
  assert.deepEqual(JSON.parse(decisionCalls[0].init.body), { pollId: "WA.poll-1", verdict: "approved" });
  assert.match(decisionCalls[0].init.headers["x-request-id"], /^council-poll-vote:[a-f0-9]{48}$/);
  assert.equal(decisionCalls[0].init.headers["x-request-id"], decisionCalls[1].init.headers["x-request-id"]);
  await processCouncilPollVote({ ...vote, messageId: "vote-2" }, config, { fetcher });
  const allDecisionCalls = calls.filter((call) => call.init.method === "POST");
  assert.notEqual(allDecisionCalls[0].init.headers["x-request-id"], allDecisionCalls[2].init.headers["x-request-id"]);
  assert.equal(calls[0].init.headers["x-council-workspace"], "solar_ops");
  const unrelated = await processCouncilPollVote({ pollMessageId: "WA.poll-2", selectedOptions: ["Approve"], chatId: "999@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-2" }, config, { fetcher: async () => { throw new Error("unrelated vote must not call Council"); } });
  assert.equal(unrelated.ok, false);
  const unknown = await processCouncilPollVote({ ...vote, pollMessageId: "foreign-poll" }, config, { registrationWaitMs: 0, fetcher: async () => { const error = new Error("not found"); error.status = 404; throw error; } });
  assert.deepEqual(unknown, { ok: false, status: "unclaimed", message: "This poll is not a registered Council approval." });
  let statusAttempts = 0;
  let delayedPosted = false;
  const delayed = await processCouncilPollVote({ ...vote, pollMessageId: "delayed-poll" }, config, { registrationWaitMs: 1_200, fetcher: async (url, token, init = {}) => {
    if (String(url).includes("/status?")) { statusAttempts += 1; if (statusAttempts < 12) { const error = new Error("not found yet"); error.status = 404; throw error; } return pollStatus("delayed-poll", delayedPosted ? "consumed" : "active"); }
    if (String(url).includes("/poll/decision?") && !init.method) return { ...pollStatus("delayed-poll", "consumed"), verdict: "approved" };
    if (init.method === "POST") delayedPosted = true;
    return { acknowledgement: "Council approved." };
  } });
  assert.equal(delayed.ok, true);
  assert.ok(statusAttempts >= 12);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("native Council poll votes preserve a registered variable scope", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  const scope = "ui:completed-records";
  let posted = false;
  let statusReads = 0;
  const fetcher = async (url, _token, init = {}) => {
    if (String(url).includes("/status?")) { statusReads += 1; return pollStatus("WA.variable", posted && statusReads > 1 ? "consumed" : "active", scope); }
    if (String(url).includes("/poll/decision?") && !init.method) return { ...pollStatus("WA.variable", "consumed", scope), verdict: "approved" };
    if (init.method === "POST") posted = true;
    return { acknowledgement: "Council approved." };
  };
  const result = await processCouncilPollVote({ pollMessageId: "WA.variable", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-variable" }, config, { fetcher });
  assert.equal(result.ok, true);
  assert.equal(posted, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("successful native Council poll votes require exact decision readback before acknowledgement", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  let posts = 0;
  const vote = { pollMessageId: "WA.poll-1", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-readback" };
  await assert.rejects(processCouncilPollVote(vote, config, { fetcher: async (url, token, init = {}) => {
    if (String(url).includes("/status?")) return pollStatus();
    if (init.method === "POST") { posts += 1; return { acknowledgement: "Council approved." }; }
    return { pollId: "WA.poll-1", caseId: "wrong-case", rev: 1, digest, scope: "design", verdict: "approved" };
  } }), /outcome is uncertain; exact readback failed/);
  assert.equal(posts, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("matching case decisions do not prove an unconsumed native Council poll vote", async () => {
  for (const postFails of [false, true]) {
    const { config, directory } = fixture();
    config.councilApprovals.nativePolls = true;
    let statusReads = 0;
    let posts = 0;
    const vote = { pollMessageId: "WA.poll-1", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: `vote-unconsumed-${postFails}` };
    await assert.rejects(processCouncilPollVote(vote, config, { fetcher: async (url, token, init = {}) => {
      if (String(url).includes("/status?")) { statusReads += 1; return pollStatus("WA.poll-1", statusReads === 1 ? "active" : "stale"); }
      if (init.method === "POST") { posts += 1; if (postFails) throw new Error("transport failed"); return { acknowledgement: "Council approved." }; }
      return { ...pollStatus("WA.poll-1", "consumed"), verdict: "approved" };
    } }), /outcome is uncertain; exact readback failed/);
    assert.equal(posts, 1);
    assert.equal(statusReads, 2);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("successful native Council poll votes surface a conflicting exact decision without retrying", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  let posts = 0;
  let statusReads = 0;
  const vote = { pollMessageId: "WA.poll-1", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-conflict" };
  const result = await processCouncilPollVote(vote, config, { fetcher: async (url, token, init = {}) => {
    if (String(url).includes("/status?")) { statusReads += 1; return pollStatus("WA.poll-1", statusReads === 1 ? "active" : "consumed"); }
    if (init.method === "POST") { posts += 1; return { acknowledgement: "Council approved." }; }
    return { ...pollStatus("WA.poll-1", "consumed"), verdict: "rejected" };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "bound-failed");
  assert.match(result.message, /already recorded rejected/);
  assert.equal(posts, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("native Council poll retries read the consumed exact decision instead of posting again", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  let consumed = false;
  let posts = 0;
  const fetcher = async (url, token, init = {}) => {
    if (String(url).includes("/status?")) return pollStatus("WA.poll-1", consumed ? "consumed" : "active");
    if (String(url).includes("/api/whatsapp/poll/decision?") && !init.method) return { ...pollStatus("WA.poll-1", "consumed"), verdict: "approved" };
    if (init.method === "POST") { posts += 1; consumed = true; return { acknowledgement: "Council approved." }; }
    throw new Error("unexpected request");
  };
  const vote = { pollMessageId: "WA.poll-1", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-replay" };
  const first = await processCouncilPollVote(vote, config, { fetcher });
  const duplicate = await processCouncilPollVote(vote, config, { fetcher });
  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, { ok: true, status: "accepted", duplicate: true, message: "Council poll decision was already recorded." });
  assert.equal(posts, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("consumed Council poll votes read back once and cannot reverse the recorded verdict", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  let posts = 0;
  const fetcher = async (url, token, init = {}) => {
    if (String(url).includes("/status?")) return pollStatus("WA.poll-1", "consumed");
    if (String(url).includes("/api/whatsapp/poll/decision?")) return { pollId: "WA.poll-1", caseId: "case_mu4vrfky_2", rev: 1, digest, scope: "design", verdict: "approved" };
    if (init.method === "POST") posts += 1;
    return {};
  };
  const base = { pollMessageId: "WA.poll-1", chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-retry" };
  const duplicate = await processCouncilPollVote({ ...base, selectedOptions: ["Approve"] }, config, { fetcher });
  const conflict = await processCouncilPollVote({ ...base, selectedOptions: ["Reject"] }, config, { fetcher });
  assert.deepEqual(duplicate, { ok: true, status: "accepted", duplicate: true, message: "Council poll decision was already recorded." });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, "bound-failed");
  assert.match(conflict.message, /approved/);
  assert.equal(posts, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("malformed consumed Council poll registrations fail closed", async () => {
  const { config, directory } = fixture();
  config.councilApprovals.nativePolls = true;
  let decisionReads = 0;
  const vote = { pollMessageId: "WA.poll-1", selectedOptions: ["Approve"], chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "vote-malformed" };
  for (const status of [
    { registered: true, status: "consumed", pollId: "WA.poll-1" },
    pollStatus("WA.poll-1", "consumed", "production bad"),
    { ...pollStatus("WA.poll-1", "consumed"), pollId: "different-poll" },
  ]) {
    const result = await processCouncilPollVote(vote, config, { fetcher: async (url) => {
      if (String(url).includes("/status?")) return status;
      decisionReads += 1;
      return { ...status, verdict: "approved" };
    } });
    assert.equal(result.ok, false);
    assert.equal(result.status, "bound-failed");
  }
  assert.equal(decisionReads, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "council-approvals-"));
  const credentialFile = path.join(directory, "codex-token");
  fs.writeFileSync(credentialFile, "codex-token\n", { mode: 0o600 });
  return {
    directory,
    config: {
      councilApprovals: {
        chatId: "120@g.us", allowedSenders: ["15551234567@s.whatsapp.net"],
        councilUrl: "https://council.example", codexCredentialFile: credentialFile, workspace: "solar_ops",
      },
    },
  };
}

test("Council approval uses Codex-only exact decision and permit reads before posting", async () => {
  const { config, directory } = fixture();
  const calls = [];
  const fetcher = async (url, token, init) => {
    calls.push({ url, token, init });
    if (url.includes("/api/whatsapp/decision?")) { const error = new Error("not found"); error.status = 404; throw error; }
    if (url.includes("/api/whatsapp/permit?")) return { ...permit(), permitId };
    return { caseId: "case_mu4vrfky_2", rev: 1, verdict: "approved" };
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].token, "codex-token");
  assert.match(calls[0].url, /workspace=solar_ops/);
  assert.match(calls[0].url, /\/api\/whatsapp\/decision\?/);
  assert.equal(calls[0].init.headers["x-council-workspace"], "solar_ops");
  assert.match(calls[1].url, /workspace=solar_ops/);
  assert.match(calls[1].url, /\/api\/whatsapp\/permit\?/);
  assert.equal(calls[1].init.headers["x-council-workspace"], "solar_ops");
  assert.equal(calls[2].init.headers["x-request-id"], `whatsapp-approval:120@g.us:msg-1:case_mu4vrfky_2:1:${digest}`);
  assert.equal(calls[2].init.headers["x-council-workspace"], "solar_ops");
  assert.match(calls[2].init.body, /"permitId":"wp_opaque_permit_123456"/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("missing owner permit never posts a Council decision", async () => {
  const { config, directory } = fixture();
  let post = false;
  const fetcher = async (url) => {
    if (url.includes("/api/whatsapp/decision?")) { const error = new Error("not found"); error.status = 404; throw error; }
    if (url.includes("/api/whatsapp/permit?")) return {};
    post = true;
    return {};
  };
  const result = await processCouncilApproval(`REJECT case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } });
  assert.equal(result.ok, false);
  assert.equal(post, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("digest mismatch and stale revision do not post", async () => {
  const { config, directory } = fixture();
  let post = false;
  const fetcher = async (url) => {
    if (url.includes("/api/whatsapp/decision?")) { const error = new Error("stale revision"); error.status = 409; throw error; }
    post = true;
    return {};
  };
  await assert.rejects(processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } }), /stale revision/);
  assert.equal(post, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("duplicate text approvals report the exact recorded decision without a second post", async () => {
  const { config, directory } = fixture();
  let posts = 0;
  const fetcher = async (url, token, init = {}) => {
    if (url.includes("/api/whatsapp/decision?")) return { caseId: "case_mu4vrfky_2", rev: 1, digest, scope: "design", verdict: "approved" };
    if (init.method === "POST") posts += 1;
    return {};
  };
  const duplicate = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-duplicate" } });
  const conflict = await processCouncilApproval(`REJECT case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-conflict" } });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(conflict.ok, false);
  assert.match(conflict.message, /approved is already recorded/);
  assert.equal(posts, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("direct broker context cannot bypass the exact Council chat, sender, or message identity", async () => {
  const { config, directory } = fixture();
  let councilReads = 0;
  const fetcher = async () => { councilReads += 1; return {}; };
  for (const context of [
    { chatId: "999@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" },
    { chatId: "120@g.us", senderId: "16661234567@s.whatsapp.net", messageId: "msg-1" },
    { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "" },
  ]) {
    const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context });
    assert.equal(result.ok, false);
  }
  assert.equal(councilReads, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("text approvals use the owner permit's exact scope instead of one fixed bridge scope", async () => {
  const { config, directory } = fixture();
  let postedBody;
  const fetcher = async (url, _token, init = {}) => {
    if (url.includes("/api/whatsapp/decision?")) { const error = new Error("not found"); error.status = 404; throw error; }
    if (url.includes("/api/whatsapp/permit?")) return { ...permit("case_mu4vrfky_2", 1, "ui:completed-records"), permitId };
    postedBody = JSON.parse(init.body);
    return { verdict: "approved" };
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-variable-scope" } });
  assert.equal(result.ok, true);
  assert.equal(postedBody.scope, "ui:completed-records");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("expired owner permits are rejected before decision post", async () => {
  const { config, directory } = fixture();
  let post = false;
  const fetcher = async (url) => {
    if (url.includes("/api/whatsapp/decision?")) { const error = new Error("not found"); error.status = 404; throw error; }
    if (url.includes("/api/whatsapp/permit?")) return { ...permit(), expiresAt: "2020-01-01T00:00:00.000Z", permitId };
    post = true;
    return {};
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-expired" } });
  assert.equal(result.ok, false);
  assert.equal(post, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("agent self-misclassification without an owner permit is denied", async () => {
  const { config, directory } = fixture();
  let post = false;
  const fetcher = async (url) => {
    if (url.includes("/api/whatsapp/decision?")) { const error = new Error("not found"); error.status = 404; throw error; }
    if (url.includes("/api/whatsapp/permit?")) return {};
    post = true;
    return {};
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-no-permit" } });
  assert.equal(result.ok, false);
  assert.equal(post, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("approval and push workspace mismatch fails before Council reads", async () => {
  const { config, directory } = fixture();
  config.councilPush = { enabled: true, workspace: "other_workspace" };
  let reads = 0;
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher: async () => { reads += 1; return {}; }, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-workspace" } });
  assert.equal(result.ok, false);
  assert.equal(reads, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a commit-then-timeout is recovered only by exact Council decision readback", async () => {
  const { config, directory } = fixture();
  const calls = [];
  let committed = false;
  const fetcher = async (url, token, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/api/whatsapp/decision?") && !committed) { const error = new Error("not found"); error.status = 404; throw error; }
    if (url.includes("/api/whatsapp/permit?")) return { ...permit(), permitId };
    if (url.includes("/api/whatsapp/decision")) {
      if (init.method === "POST") { committed = true; throw new Error("socket timeout after commit"); }
      return committed ? { caseId: "case_mu4vrfky_2", rev: 1, verdict: "approved", scope: "design" } : { caseId: "wrong", rev: 1, verdict: "approved", scope: "design" };
    }
    throw new Error("unexpected request");
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-timeout" } });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(calls.length, 4);
  assert.match(calls[3].url, /workspace=solar_ops/);
  assert.equal(calls[3].init.headers["x-council-workspace"], "solar_ops");
  fs.rmSync(directory, { recursive: true, force: true });
});
