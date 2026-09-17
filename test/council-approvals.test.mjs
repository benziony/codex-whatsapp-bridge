import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCurrentWhatsappPermit, parseCouncilApproval, processCouncilApproval } from "../scripts/lib/council-approvals.mjs";

const digest = "a".repeat(64);
const permitId = "wp_opaque_permit_123456";
const permit = (caseId = "case_mu4vrfky_2", rev = 1, scope = "design") => ({ caseId, rev, digest, scope, issuedBy: "owner", issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });

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

test("Council approval rechecks pending revision, digest, channel, and risk before posting", async () => {
  const { config, directory } = fixture();
  const calls = [];
  const fetcher = async (url, token, init) => {
    calls.push({ url, token, init });
    if (url.includes("/api/dashboard?")) return {
      pendingDecisions: [{ caseId: "case_mu4vrfky_2", rev: 1, digest, approvalChannels: ["web"], riskClass: "financial", expiresAt: "expired-agent-field", superseded: false }],
    };
    if (url.includes("/api/whatsapp/permit?")) return { ...permit(), permitId };
    return { caseId: "case_mu4vrfky_2", rev: 1, verdict: "approved" };
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].token, "codex-token");
  assert.match(calls[0].url, /workspace=solar_ops/);
  assert.equal(calls[0].init.headers["x-council-workspace"], "solar_ops");
  assert.match(calls[1].url, /workspace=solar_ops/);
  assert.equal(calls[1].init.headers["x-council-workspace"], "solar_ops");
  assert.equal(calls[2].init.headers["x-request-id"], `whatsapp-approval:120@g.us:msg-1:case_mu4vrfky_2:1:${digest}`);
  assert.equal(calls[2].init.headers["x-council-workspace"], "solar_ops");
  assert.match(calls[2].init.body, /"permitId":"wp_opaque_permit_123456"/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("web-only, unknown-risk, and denied-risk proposals never post", async () => {
  for (const proposal of [
    { approvalChannels: ["web"], riskClass: "routine" },
    { approvalChannels: ["whatsapp"], riskClass: "unknown" },
    { approvalChannels: ["whatsapp"], riskClass: "financial" },
  ]) {
    const { config, directory } = fixture();
    let post = false;
    const fetcher = async (url) => {
      if (url.includes("/api/dashboard?")) return { pendingDecisions: [{ caseId: "case_mu4vrfky_2", rev: 1, digest, superseded: false, ...proposal }] };
      if (url.includes("/api/whatsapp/permit?")) return {};
      post = true;
      return {};
    };
    const result = await processCouncilApproval(`REJECT case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } });
    assert.equal(result.ok, false);
    assert.equal(post, false);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("digest mismatch and stale revision do not post", async () => {
  const { config, directory } = fixture();
  let post = false;
    const fetcher = async (url) => {
      if (url.includes("/api/dashboard?")) return { pendingDecisions: [{ caseId: "case_mu4vrfky_2", rev: 2, digest, permitId, approvalChannels: ["whatsapp"], riskClass: "routine", whatsappPermit: permit("case_mu4vrfky_2", 2) }] };
    post = true;
    return {};
  };
  const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } });
  assert.equal(result.ok, false);
  assert.equal(post, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("direct broker context cannot bypass the exact Council chat, sender, or message identity", async () => {
  const { config, directory } = fixture();
  let dashboardReads = 0;
  const fetcher = async (url) => {
    dashboardReads += 1;
    return { pendingDecisions: [] };
  };
  for (const context of [
    { chatId: "999@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" },
    { chatId: "120@g.us", senderId: "16661234567@s.whatsapp.net", messageId: "msg-1" },
    { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "" },
  ]) {
    const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context });
    assert.equal(result.ok, false);
  }
  assert.equal(dashboardReads, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("scope mismatch and expired proposal are rejected before decision post", async () => {
  for (const metadata of [{ whatsappPermit: { ...permit(), scope: "production" } }, { whatsappPermit: { ...permit(), expiresAt: "2020-01-01T00:00:00.000Z" } }]) {
    const { config, directory } = fixture();
    let post = false;
    const fetcher = async (url) => {
      if (url.includes("/api/dashboard?")) return { pendingDecisions: [{ caseId: "case_mu4vrfky_2", rev: 1, digest, approvalChannels: ["whatsapp"], riskClass: "routine" }] };
      if (url.includes("/api/whatsapp/permit?")) return { ...metadata.whatsappPermit, permitId };
      post = true;
      return {};
    };
    const result = await processCouncilApproval(`APPROVE case_mu4vrfky_2 REV 1 DIGEST ${digest}`, config, { fetcher, context: { chatId: "120@g.us", senderId: "15551234567@s.whatsapp.net", messageId: "msg-1" } });
    assert.equal(result.ok, false);
    assert.equal(post, false);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agent self-misclassification without an owner permit is denied", async () => {
  const { config, directory } = fixture();
  let post = false;
  const fetcher = async (url) => {
    if (url.includes("/api/dashboard?")) return { pendingDecisions: [{ caseId: "case_mu4vrfky_2", rev: 1, digest, approvalChannels: ["whatsapp"], riskClass: "routine", scope: "design" }] };
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
    if (url.includes("/api/dashboard?")) return { pendingDecisions: [{ caseId: "case_mu4vrfky_2", rev: 1, digest }] };
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
