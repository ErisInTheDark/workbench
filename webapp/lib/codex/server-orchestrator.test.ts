/*
 * Exports:
 * - No production exports; Node tests cover server orchestrator origin resolution, HTTP result adaptation, and network-only fallback. Keywords: orchestrator, http, server, fallback, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

import { getCodexAppServerPort } from "./config";
import {
  getServerWorkbenchOrchestratorOrigins,
  sendServerWorkbenchOrchestratorRequest,
} from "./server-orchestrator";

function request() {
  return new NextRequest("http://localhost:3000/api/subagents");
}

test("prefers the request host and returns unique HTTP orchestrator origins", () => {
  const origins = getServerWorkbenchOrchestratorOrigins(request());
  assert.equal(origins[0], `http://localhost:${getCodexAppServerPort()}`);
  assert.equal(new Set(origins).size, origins.length);
  assert.ok(origins.every((origin) => origin.startsWith("http://") || origin.startsWith("https://")));
});

test("returns one buffered orchestrator bridge result", async () => {
  const calls: string[] = [];
  const result = await sendServerWorkbenchOrchestratorRequest<{ ok: boolean }>(
    request(),
    "codex",
    { method: "workbench/subagent/list", params: {} },
    {
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ result: { ok: true } });
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
});

test("retries network failures but never retries an HTTP application error", async () => {
  let networkCalls = 0;
  const result = await sendServerWorkbenchOrchestratorRequest<{ ok: boolean }>(
    request(),
    "codex",
    { method: "workbench/subagent/list", params: {} },
    {
      fetchImpl: async () => {
        networkCalls += 1;
        if (networkCalls === 1) throw new Error("simulated network failure");
        return Response.json({ result: { ok: true } });
      },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(networkCalls, 2);

  let applicationCalls = 0;
  await assert.rejects(sendServerWorkbenchOrchestratorRequest(
    request(),
    "codex",
    { method: "workbench/subagent/list", params: {} },
    {
      fetchImpl: async () => {
        applicationCalls += 1;
        return Response.json({ error: "simulated application failure" }, { status: 400 });
      },
    },
  ), /simulated application failure/u);
  assert.equal(applicationCalls, 1);
});
