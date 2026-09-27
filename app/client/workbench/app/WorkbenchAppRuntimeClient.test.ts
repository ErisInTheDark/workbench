/*
 * No production exports. Tests protect non-fatal bootstrap failure, frontend freshness, and app-owned reload requests.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchAppRuntimeClient from "./WorkbenchAppRuntimeClient.ts";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

test("keeps runtime discovery failure visible without rejecting app bootstrap", async () => {
  const scheduled: Array<() => void> = [];
  const client = new WorkbenchAppRuntimeClient({
    fetcher: (() => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch,
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    visibility: { hidden: () => false, subscribe: () => () => {} },
  });
  const snapshot = await client.bootstrap();
  assert.match(snapshot.error ?? "", /missing/u);
  assert.equal(scheduled.length, 1);
  client.dispose();
});

test("posts selected client scopes and accepts the shared reload response", async () => {
  let body = "";
  const client = new WorkbenchAppRuntimeClient({
    fetcher: ((_input, init) => {
      body = String(init?.body);
      return Promise.resolve(Response.json({
        appliedScopes: [],
        completedAt: null,
        error: null,
        ok: true,
        queuedScopes: ["client:http"],
        requestedScopes: ["client:http"],
        startedAt: 1,
        state: "running",
      }));
    }) as typeof fetch,
  });
  assert.equal((await client.reloadScopes(["client:http"])).state, "running");
  assert.deepEqual(JSON.parse(body), { scopes: ["client:http"] });
});

test("requests dependant metadata and defaults it for an older app response", async () => {
  let requested = "";
  const client = new WorkbenchAppRuntimeClient({
    fetcher: ((input) => {
      requested = String(input);
      return Promise.resolve(Response.json({
        reloadDirt: {
          dirtyScopes: [{ description: "HTTP", destructive: false, scope: "client:http" }],
          error: null,
          pendingScopes: [],
        },
      }));
    }) as typeof fetch,
    loadedFrontendGeneration: {
      javascript: "javascript-loaded",
      stylesheet: "stylesheet-loaded",
    },
    schedule: () => 1,
    visibility: { hidden: () => false, subscribe: () => () => {} },
  });
  const snapshot = await client.bootstrap();
  assert.equal(requested, "/api/workbench-app-runtime?version=4");
  assert.deepEqual(snapshot.dirtyScopes[0]?.dependantScopes, []);
  assert.equal(snapshot.tabOutOfDate, false);
  client.dispose();
});

test("derives tab freshness from both loaded frontend generations", async () => {
  const loadedFrontendGeneration = {
    javascript: "javascript-loaded",
    stylesheet: "stylesheet-loaded",
  };
  const cases = [
    {
      current: loadedFrontendGeneration,
      expected: false,
      name: "matching output",
    },
    {
      current: { ...loadedFrontendGeneration, javascript: "javascript-new" },
      expected: true,
      name: "new JavaScript",
    },
    {
      current: { ...loadedFrontendGeneration, stylesheet: "stylesheet-new" },
      expected: true,
      name: "new stylesheet",
    },
  ];

  for (const fixture of cases) {
    const client = new WorkbenchAppRuntimeClient({
      fetcher: (() => Promise.resolve(Response.json({
        frontendGeneration: fixture.current,
        reloadDirt: {
          dirtyScopes: [],
          error: null,
          pendingScopes: [],
        },
      }))) as typeof fetch,
      loadedFrontendGeneration,
      schedule: () => 1,
      visibility: { hidden: () => false, subscribe: () => () => {} },
    });
    const snapshot = await client.bootstrap();
    assert.equal(snapshot.tabOutOfDate, fixture.expected, fixture.name);
    client.dispose();
  }
});

test("RPC runtime observes changes without scheduling idle HTTP polls", async () => {
  const notices: Array<(event: { kind: string }) => void> = [];
  const requests: string[] = [];
  let generation = "loaded";
  const rpc = {
    available: true,
    requestRaw: async (intent: { method: string }) => {
      requests.push(intent.method);
      return {
        frontendGeneration: { javascript: generation, stylesheet: "same" },
        reloadDirt: { dirtyScopes: [], error: null, pendingScopes: [] },
      };
    },
    onEvent: (listener: (event: { kind: string }) => void) => {
      notices.push(listener);
      return () => { notices.splice(notices.indexOf(listener), 1); };
    },
    onReconnect: () => () => {},
  } as unknown as WorkbenchAppRpcClient;
  const client = new WorkbenchAppRuntimeClient({
    rpc,
    loadedFrontendGeneration: { javascript: "loaded", stylesheet: "same" },
    fetcher: async () => { throw new Error("Unexpected HTTP runtime read."); },
    schedule: () => { throw new Error("Idle runtime poll scheduled."); },
    visibility: { hidden: () => false, subscribe: () => () => {} },
  });
  try {
    await client.bootstrap();
    assert.deepEqual(requests, ["app/runtime/read"]);
    generation = "new";
    const changed = new Promise<void>(resolve => {
      const release = client.subscribe(() => {
        if (!client.getSnapshot().tabOutOfDate) return;
        release();
        resolve();
      });
    });
    notices[0]?.({ kind: "runtime" });
    await changed;
    assert.deepEqual(requests, ["app/runtime/read", "app/runtime/read"]);
  } finally { client.dispose(); }
});

test("a runtime change during bootstrap is read after the first response", async () => {
  const initial = Promise.withResolvers<object>();
  const requested = Promise.withResolvers<void>();
  const notices: Array<(event: { kind: string }) => void> = [];
  let reads = 0;
  const response = (javascript: string) => ({
    frontendGeneration: { javascript, stylesheet: "same" },
    reloadDirt: { dirtyScopes: [], error: null, pendingScopes: [] },
  });
  const rpc = {
    available: true,
    requestRaw: async () => {
      reads++;
      if (reads === 1) {
        requested.resolve();
        return await initial.promise;
      }
      return response("new");
    },
    onEvent: (listener: (event: { kind: string }) => void) => {
      notices.push(listener);
      return () => { notices.splice(notices.indexOf(listener), 1); };
    },
    onReconnect: () => () => {},
  } as unknown as WorkbenchAppRpcClient;
  const client = new WorkbenchAppRuntimeClient({
    rpc,
    loadedFrontendGeneration: { javascript: "loaded", stylesheet: "same" },
    visibility: { hidden: () => false, subscribe: () => () => {} },
  });
  const boot = client.bootstrap();
  try {
    await requested.promise;
    assert.equal(notices.length, 1, "listen before awaiting the bootstrap read");
    const updated = new Promise<void>(resolve => {
      const release = client.subscribe(() => {
        if (!client.getSnapshot().tabOutOfDate) return;
        release();
        resolve();
      });
    });
    notices[0]?.({ kind: "runtime" });
    initial.resolve(response("loaded"));
    await boot;
    await updated;
    assert.equal(reads, 2);
  } finally {
    initial.resolve(response("loaded"));
    await boot.catch(() => undefined);
    client.dispose();
  }
});
