/*
 * No exports. Tests protect recovery ingress independently of gated feature work.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeClient, JsonRpcResponse } from "./bridge-types";
import WorkbenchDaemonControlIngress, { type WorkbenchDaemonControlIngressOptions } from "./WorkbenchDaemonControlIngress";

function fixture(overrides: Partial<WorkbenchDaemonControlIngressOptions> = {}, send?: BridgeClient["send"]) {
  const responses: JsonRpcResponse[] = [];
  const errors: string[] = [];
  const client: BridgeClient = {
    OPEN: 1, readyState: 1, close: () => undefined, on: () => undefined, once: () => undefined,
    send: send ?? ((data, callback) => { responses.push(JSON.parse(data)); callback?.(); }),
  };
  const ingress = new WorkbenchDaemonControlIngress({
    dispatch: async () => { throw new Error("feature graph is gated"); },
    getReloadController: () => { throw new Error("reload owner must not be read for health"); },
    logError: (message) => errors.push(message),
    ...overrides,
  });
  const handle = (method: string, params: object = {}) => ingress.handle(client, "client", Buffer.from(JSON.stringify({ id: 7, method, params })));
  return { client, errors, handle, responses };
}

test("health bypasses blocked feature work and validates its own params", async () => {
  const target = fixture();
  await target.handle("workbench/daemon/health");
  assert.deepEqual(target.responses, [{ id: 7, result: { ok: true } }]);
  const invalid = fixture();
  await invalid.handle("workbench/daemon/health", { unexpected: true });
  assert.ok(invalid.responses[0]?.error);
});

test("reload resolves the current owner and starts only after its response is sent", async () => {
  let reportSent!: () => void;
  const sent = new Promise<void>((resolve) => { reportSent = resolve; });
  const events: string[] = [];
  let finishSend!: () => void;
  let generation = 1;
  const target = fixture({
    dispatch: async () => { events.push("gated dispatch"); reportSent(); },
    getReloadController: () => ({
      admitUserReload: () => {
        events.push(`admit ${generation}`);
        return {
          cancel: () => events.push("cancel"),
          response: { appliedScopes: [], completedAt: null, error: null, ok: true, queuedScopes: ["server:process"], requestedScopes: ["server:process"], startedAt: 1, state: "running" },
          start: async () => { events.push("start"); },
        };
      },
    }),
  }, (_data, callback) => { finishSend = () => callback?.(); reportSent(); });
  generation = 2;
  const handling = target.handle("workbench/daemon/reload", { scopes: ["server:process"] });
  await sent;
  assert.deepEqual(events, ["admit 2"]);
  finishSend();
  await handling;
  assert.deepEqual(events, ["admit 2", "start"]);
});

test("failed response delivery cancels reload admission instead of starting it", async () => {
  const events: string[] = [];
  const target = fixture({
    getReloadController: () => ({
      admitUserReload: () => ({
        cancel: () => events.push("cancel"),
        response: { appliedScopes: [], completedAt: null, error: null, ok: true, queuedScopes: [], requestedScopes: [], startedAt: 1, state: "running" },
        start: async () => { events.push("start"); },
      }),
    }),
  }, (_data, callback) => callback?.(new Error("socket write failed")));
  await assert.rejects(target.handle("workbench/daemon/reload", { scopes: ["server:core"] }), /socket write failed/u);
  assert.deepEqual(events, ["cancel"]);
});

test("ordinary request admission failure returns an RPC error rather than hanging the caller", async () => {
  const target = fixture();
  await target.handle("workbench/thread-state/open");
  assert.equal(target.responses[0]?.error?.message, "feature graph is gated");
  assert.equal(target.errors.length, 1);
});
