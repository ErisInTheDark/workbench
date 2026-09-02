/*
 * No production exports. Tests protect non-fatal bootstrap failure, frontend freshness, and app-owned reload requests.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchAppRuntimeClient from "./WorkbenchAppRuntimeClient.ts";

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
  assert.equal(requested, "/api/workbench-app-runtime?version=3");
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
