/*
 * Exports:
 * - No production exports; tests protect daemon transport failure and domain result boundaries. Keywords: daemon, rpc, failure, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GitArcFailureException } from "../git/git-arc-failures.ts";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "./WorkbenchDaemonClient.ts";

test("transport failures never fall back to app HTTP", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json({ localCapabilities: { browseRawCommandsEnabled: true } });
  };
  try {
    const unavailable = new WorkbenchDaemonClient({ request: async () => { throw new Error("daemon disconnected"); } });
    await assert.rejects(
      unavailable.request("local-capabilities/read", {}),
      /daemon disconnected/u,
    );
    assert.equal(fetches, 0);

    const missingMethod = new WorkbenchDaemonClient({
      request: async () => { throw new WorkbenchDaemonRequestError("method not found", -32601); },
    });
    await assert.rejects(
      missingMethod.request("local-capabilities/read", {}),
      /method not found/u,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Git arc requests return exact domain results and preserve structured failures", async () => {
  const comparison = {
    changes: [],
    checkpointCommit: "a".repeat(40),
    checkpointRef: "refs/workbench/arc",
    intentName: "typed Git request",
    repoRoot: "C:/git/web/workbench",
    scopePaths: ["webapp"],
  };
  const success = new WorkbenchDaemonClient({
    request: async <TResponse>() => comparison as TResponse,
  });
  assert.deepEqual(
    await success.requestGitArc("git/arc/compare", {
      cwd: "C:/git/web/workbench",
      harness: "codex",
      refs: [],
      roots: [],
      threadId: "thread",
    }),
    comparison,
  );

  const failure = {
    action: "compare" as const,
    code: "operationRejected" as const,
    message: "Comparison was rejected.",
    version: 1 as const,
  };
  const rejected = new WorkbenchDaemonClient({
    request: async () => {
      throw new WorkbenchDaemonRequestError("Comparison was rejected.", -32000, { gitArcFailure: failure });
    },
  });
  await assert.rejects(
    rejected.requestGitArc("git/arc/compare", {
      cwd: "C:/git/web/workbench",
      harness: "codex",
      refs: [],
      roots: [],
      threadId: "thread",
    }),
    (error) => error instanceof GitArcFailureException
      && assert.deepEqual(error.failure, failure) === undefined,
  );
});
