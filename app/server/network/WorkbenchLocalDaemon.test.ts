/* No production exports. Protect stale-process rejection and invalidation/disposal of endpoint verification. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchLocalDaemon from "./WorkbenchLocalDaemon.ts";
import type { WorkbenchDaemonEndpoint } from "workbench-shared/http/workbench-daemon-endpoint";

const endpoint: WorkbenchDaemonEndpoint = {
  version: 1, instanceId: "6e1a6f64-af71-4639-b997-65d8f314b352", pid: 1234, origin: "http://127.0.0.1:32123",
};

test("an unresponsive published endpoint cannot block app startup and closes through its observer", async context => {
  const owner = new WorkbenchLocalDaemon({
    endpointPath: "unused", read: async () => endpoint, observe: () => () => {}, warn: assert.fail,
    fetcher: async (_input, options) => new Promise<Response>((_resolve, reject) => {
      const signal = options!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  context.after(() => owner.close());
  await owner.start();
  assert.equal(owner.getSnapshot().endpoint, null);
  await owner.close();
});

test("a failed watcher cannot report a healthy observed endpoint until its owner is replaced", async () => {
  let failObservation!: () => void;
  const warnings: string[] = [];
  const owner = new WorkbenchLocalDaemon({
    endpointPath: "unused", read: async () => endpoint,
    observe: (_changed, failed) => { failObservation = failed; return () => {}; },
    fetcher: async () => Response.json(endpoint), warn: message => warnings.push(message),
  });
  await owner.start();
  await owner.refresh();
  assert.ok(owner.getSnapshot().endpoint);
  failObservation();
  await owner.refresh();
  assert.equal(owner.getSnapshot().endpoint, null);
  assert.ok(owner.getSnapshot().failure);
  assert.equal(warnings.length, 1);
  await owner.close();
});

test("a recycled port cannot impersonate the published daemon process", async () => {
  const warnings: string[] = [];
  let current: WorkbenchDaemonEndpoint | null = endpoint;
  const owner = new WorkbenchLocalDaemon({
    endpointPath: "unused", read: async () => current, observe: () => () => {},
    warn: message => warnings.push(message),
    fetcher: async () => Response.json({ ...endpoint, instanceId: "8a87278e-9726-433b-aad8-a0a0372cf066" }),
  });
  await owner.start();
  await owner.refresh();
  assert.equal(owner.getSnapshot().endpoint, null);
  assert.equal(warnings.length, 1);
  current = null;
  await owner.refresh();
  assert.deepEqual(owner.getSnapshot(), { endpoint: null, failure: null });
  await owner.close();
});

test("a replacement invalidates the old verification and disposal cancels the current request", async () => {
  let current = endpoint;
  let requestStarted!: () => void;
  let entered = new Promise<void>(resolve => { requestStarted = resolve; });
  let activeSignal: AbortSignal | null = null;
  let blocked = true;
  const owner = new WorkbenchLocalDaemon({
    endpointPath: "unused", read: async () => current, observe: () => () => {}, warn: assert.fail,
    fetcher: async (_input, options) => {
      if (!blocked) return Response.json(current);
      const signal = options!.signal!;
      activeSignal = signal;
      requestStarted();
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const started = owner.start();
  await entered;
  current = { ...endpoint, origin: "http://127.0.0.1:32124" };
  blocked = false;
  await owner.refresh();
  await started;
  assert.deepEqual(owner.getSnapshot().endpoint, current);
  blocked = true;
  current = { ...current, origin: "http://127.0.0.1:32125" };
  entered = new Promise<void>(resolve => { requestStarted = resolve; });
  const refreshing = owner.refresh();
  await entered;
  assert.equal(owner.getSnapshot().endpoint, null, "retired endpoints must disappear before replacement verification completes");
  await owner.close();
  await refreshing;
  assert.ok(activeSignal);
  assert.equal((activeSignal as AbortSignal).aborted, true);
});
