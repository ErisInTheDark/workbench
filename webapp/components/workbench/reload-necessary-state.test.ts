/*
 * No production exports. Tests protect confirmation duration and admitted reload completion as destructive-scope and lifecycle invariants. Keywords: reload, hold, destructive, status, cancellation, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrchestratorReloadResponse } from "../../lib/types";
import {
  DESTRUCTIVE_RELOAD_HOLD_MS,
  getReloadAllHoldMs,
  getReloadScopeHoldMs,
  NORMAL_RELOAD_HOLD_MS,
  readReloadResponse,
  waitForReloadCompletion,
} from "./reload-necessary-state";

const regular = { description: "Core", destructive: false, scope: "server:core" } as const;
const destructive = { description: "Codex harness", destructive: true, scope: "harness:codex" } as const;

test("destructive scopes require the long hold and reload all uses the longest hold", () => {
  assert.equal(getReloadScopeHoldMs(regular), NORMAL_RELOAD_HOLD_MS);
  assert.equal(getReloadScopeHoldMs(destructive), DESTRUCTIVE_RELOAD_HOLD_MS);
  assert.equal(getReloadAllHoldMs([regular]), NORMAL_RELOAD_HOLD_MS);
  assert.equal(getReloadAllHoldMs([regular, destructive]), DESTRUCTIVE_RELOAD_HOLD_MS);
});

test("reload response parsing accepts terminal payloads and bounded errors", async () => {
  const terminal = await readReloadResponse(Response.json(response("succeeded")));
  assert.equal("state" in terminal ? terminal.state : null, "succeeded");
  assert.deepEqual(
    await readReloadResponse(Response.json({ error: "reload failed" }, { status: 502 })),
    { error: "reload failed" },
  );
});

test("reload response parsing bounds HTML and empty responses without exposing their bodies", async () => {
  await assert.rejects(
    readReloadResponse(new Response("<!DOCTYPE html><p>secret route body</p>", {
      headers: { "Content-Type": "text/html" },
      status: 404,
    })),
    (error: unknown) => error instanceof Error
      && /HTML.*HTTP 404/u.test(error.message)
      && !error.message.includes("secret route body"),
  );
  await assert.rejects(
    readReloadResponse(new Response("", { status: 502 })),
    /empty response \(HTTP 502\)/u,
  );
  await assert.rejects(
    readReloadResponse(Response.json({}, { status: 200 })),
    /invalid response/u,
  );
});

function response(state: "failed" | "running" | "succeeded", startedAt = 100): OrchestratorReloadResponse {
  return {
    appliedScopes: ["server:core"],
    completedAt: state === "running" ? null : 200,
    error: state === "failed" ? "retirement failed" : null,
    ok: true,
    queuedScopes: [],
    requestedScopes: ["server:core"],
    startedAt,
    state,
  };
}

test("an admitted reload waits for the matching terminal response", async () => {
  const statuses = [response("running"), response("succeeded")];
  const reads: number[] = [];
  const result = await waitForReloadCompletion({
    admission: response("running"),
    readStatus: async () => {
      reads.push(reads.length);
      return statuses.shift()!;
    },
    signal: new AbortController().signal,
    wait: async () => undefined,
  });
  assert.equal(result.state, "succeeded");
  assert.equal(reads.length, 2);
});

test("reload completion preserves terminal failure details", async () => {
  const result = await waitForReloadCompletion({
    admission: response("running"),
    readStatus: async () => response("failed"),
    signal: new AbortController().signal,
    wait: async () => undefined,
  });
  assert.equal(result.error, "retirement failed");
  assert.equal(result.state, "failed");
});

test("reload completion rejects status from a replacement request", async () => {
  await assert.rejects(waitForReloadCompletion({
    admission: response("running"),
    readStatus: async () => response("succeeded", 101),
    signal: new AbortController().signal,
    wait: async () => undefined,
  }), /status was replaced/u);
});

test("reload completion obeys caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("component unmounted");
  controller.abort(reason);
  await assert.rejects(waitForReloadCompletion({
    admission: response("running"),
    readStatus: async () => response("succeeded"),
    signal: controller.signal,
    wait: async (signal) => {
      if (signal.aborted) throw signal.reason;
    },
  }), (error) => error === reason);
});
