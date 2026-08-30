import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeHookSpecs,
  evaluateBridgeHookTrust,
} from "../scripts/lib/codex-hooks.mjs";

const command = "/opt/homebrew/opt/node@24/bin/node /repo/scripts/codex-whatsapp-client.mjs hook";
const sourcePath = "/codex/hooks.json";

function response(overrides = {}) {
  const hooks = bridgeHookSpecs.map((spec, index) => ({
    key: `${sourcePath}:${spec.eventName}:${index}:0`,
    handlerType: "command",
    command,
    sourcePath,
    eventName: spec.eventName,
    matcher: spec.matcher,
    timeoutSec: spec.timeoutSec,
    statusMessage: spec.statusMessage,
    enabled: true,
    trustStatus: "trusted",
  }));
  return {
    data: [
      {
        cwd: "/repo",
        hooks: overrides.hooks ?? hooks,
        warnings: overrides.warnings ?? [],
        errors: overrides.errors ?? [],
      },
    ],
  };
}

test("turn bridge hook trust requires exact queued-submit and Stop definitions", () => {
  assert.deepEqual(evaluateBridgeHookTrust(response(), { command, sourcePath }), {
    ok: true,
    ready: true,
    expectedCount: 2,
    trustedCount: 2,
    issues: [],
  });
});

test("bridge hook trust reports a disabled handler", () => {
  const hooks = response().data[0].hooks;
  hooks.find((hook) => hook.eventName === "stop").enabled = false;
  assert.deepEqual(
    evaluateBridgeHookTrust(response({ hooks }), { command, sourcePath }),
    {
      ok: false,
      ready: false,
      expectedCount: 2,
      trustedCount: 1,
      issues: ["stop:disabled"],
    },
  );
});

test("bridge hook trust rejects definition drift", () => {
  const hooks = response().data[0].hooks;
  hooks.find((hook) => hook.eventName === "userPromptSubmit").timeoutSec = 99;
  assert.deepEqual(
    evaluateBridgeHookTrust(response({ hooks }), { command, sourcePath }),
    {
      ok: false,
      ready: false,
      expectedCount: 2,
      trustedCount: 1,
      issues: ["userPromptSubmit:definition-mismatch"],
    },
  );
});

test("bridge hook trust rejects duplicates and discovery errors", () => {
  const hooks = response().data[0].hooks;
  hooks.push({ ...hooks.find((hook) => hook.eventName === "stop") });
  assert.deepEqual(
    evaluateBridgeHookTrust(response({ hooks, errors: [{ path: sourcePath, message: "invalid" }] }), { command, sourcePath }),
    {
      ok: false,
      ready: false,
      expectedCount: 2,
      trustedCount: 1,
      issues: ["stop:duplicate", "discovery-errors"],
    },
  );
});
