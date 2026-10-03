/* No exports. Protect source-scoped runtime facts, ordered reload completion and app-routed intent. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";
import type { WorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
import WorkbenchDaemonRuntimeClient from "./WorkbenchDaemonRuntimeClient";
import { createWorkspaceClientFixture } from "./app/workspace-client-fixture";

test("newer runtime facts cannot be replaced by an old response and only successful server completion notifies", async context => {
  const f = createWorkspaceClientFixture();
  const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const owner = new WorkbenchDaemonRuntimeClient({ workspace: f.workspace, daemonId });
  context.after(() => { owner.dispose(); f.dispose(); });
  const socket = await f.open();
  await owner.open();
  const request = await socket.request("workspace/observe");
  assert.deepEqual(request.params.query, { kind: "daemonRuntime", daemonId });
  let completed = 0;
  owner.subscribeServerReloadCompleted(() => { completed++; });
  const update = async (revision: number, pendingScopes: WorkbenchReloadScope[], error: string | null = null, response = false) => {
    const data: Extract<WorkspaceObservation, { kind: "daemonRuntime" }>["data"] = {
      dirtyScopes: [{ dependantScopes: [], description: "Core", destructive: false, scope: "server:core" }], pendingScopes, error,
    };
    await socket.observation(request, { kind: "daemonRuntime", daemonId, data, phase: "current", failure: null }, revision, response);
  };
  await update(2, ["server:core"]);
  await update(1, [], null, true);
  assert.deepEqual(owner.getSnapshot().pendingScopes, ["server:core"]);
  await update(3, [], "reload failed");
  await update(4, ["client:compiler"]);
  await update(5, []);
  assert.equal(completed, 0);
  await update(6, ["server:database"]);
  await update(7, []);
  assert.equal(completed, 1);
  await update(7, []);
  assert.equal(completed, 1);
  owner.dispose();
  await update(8, ["server:core"]);
  assert.deepEqual(owner.getSnapshot().pendingScopes, []);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("reload commands retain the selected daemon and do not infer completion from admission", async context => {
  const f = createWorkspaceClientFixture();
  const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const owner = new WorkbenchDaemonRuntimeClient({ workspace: f.workspace, daemonId });
  context.after(() => { owner.dispose(); f.dispose(); });
  const socket = await f.open();
  let completed = false;
  owner.subscribeServerReloadCompleted(() => { completed = true; });
  const reload = owner.reloadScopes(["server:core"]);
  const request = await socket.request("workspace/daemon/reload");
  assert.deepEqual(request.params, { daemonId, request: { scopes: ["server:core"] } });
  socket.reply(request, { appliedScopes: [], completedAt: null, error: null, ok: true,
    queuedScopes: ["server:core"], requestedScopes: ["server:core"], startedAt: 1, state: "running" });
  assert.equal((await reload).state, "running");
  assert.equal(completed, false);
});
