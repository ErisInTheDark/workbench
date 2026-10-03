/* No production exports. Protect independent runtime facts, bundle freshness and reload handoff. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppRuntimeClient from "./WorkbenchAppRuntimeClient";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";

test("runtime loading is independent and pushed bundle changes mark this tab stale", async context => {
  const fixture = createWorkspaceClientFixture();
  const loaded = { javascript: "loaded-js", stylesheet: "loaded-css" };
  const client = new WorkbenchAppRuntimeClient({ workspace: fixture.workspace, loadedFrontendGeneration: loaded });
  context.after(() => { client.dispose(); fixture.dispose(); });
  await client.bootstrap();
  assert.equal(client.getSnapshot().tabOutOfDate, false);
  const socket = await fixture.open();
  const query = await socket.request("workspace/observe");
  const data = { frontendGeneration: loaded, reloadDirt: { dirtyScopes: [], pendingScopes: [], error: null } };
  await socket.observation(query, { kind: "runtime", phase: "current", failure: null, data });
  assert.equal(client.getSnapshot().tabOutOfDate, false);
  await socket.observation(query, { kind: "runtime", phase: "current", failure: null,
    data: { ...data, frontendGeneration: { ...loaded, stylesheet: "new-css" } } }, 2);
  assert.equal(client.getSnapshot().tabOutOfDate, true);
  await socket.observation(query, { kind: "runtime", phase: "failed", failure: "runtime read failed", data: null }, 3);
  assert.equal(client.getSnapshot().tabOutOfDate, true);
  assert.equal(client.getSnapshot().error, "runtime read failed");
  await socket.observation(query, { kind: "runtime", phase: "current", failure: null, data }, 4);
  assert.equal(client.getSnapshot().error, null);
});

test("reload uses its connection-changing HTTP handoff and preserves the selected scopes", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  let requested: object | null = null;
  const client = new WorkbenchAppRuntimeClient({
    workspace: fixture.workspace,
    fetcher: async (_input, init) => {
      requested = JSON.parse(String(init?.body));
      return Response.json({ ok: true, completedAt: null, appliedScopes: [], queuedScopes: ["client:http"],
        requestedScopes: ["client:http"], state: "running", startedAt: 1, error: null });
    },
  });
  context.after(() => client.dispose());
  assert.equal((await client.reloadScopes(["client:http"])).state, "running");
  assert.deepEqual(requested, { scopes: ["client:http"] });
});
