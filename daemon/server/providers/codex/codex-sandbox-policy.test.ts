/*
 * No production exports. Tests protect authoritative server replacement of browser-supplied Codex sandbox policy. Keywords: Codex, sandbox, network, policy, security, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyServerCodexSandboxPolicy } from "./codex-sandbox-policy";

test("server Codex sandbox policy replaces hostile browser authority and preserves canonical roots", () => {
  const request = {
    method: "turn/start",
    params: {
      input: [],
      sandboxPolicy: { type: "dangerFullAccess" },
      threadId: "thread",
    },
  };
  applyServerCodexSandboxPolicy(request, ["C:/project", "C:/other", "C:/project"], false);
  assert.deepEqual(request.params, {
    input: [],
    sandboxPolicy: {
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
      type: "workspaceWrite",
      writableRoots: ["C:/project", "C:/other"],
    },
    threadId: "thread",
  });
});

test("server Codex sandbox policy enables only its network field when configured", () => {
  const request = {
    method: "turn/start",
    params: {
      sandboxPolicy: {
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
        networkAccess: false,
        type: "workspaceWrite",
        writableRoots: ["C:/browser-choice"],
      },
      threadId: "thread",
    },
  };
  const policy = applyServerCodexSandboxPolicy(request, ["C:/validated"], true);
  assert.deepEqual(policy, {
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess: true,
    type: "workspaceWrite",
    writableRoots: ["C:/validated"],
  });
});

test("server Codex sandbox policy fails closed without a validated writable root", () => {
  assert.throws(
    () => applyServerCodexSandboxPolicy({ method: "turn/start", params: {} }, [], true),
    /server-resolved writable root/u,
  );
});
