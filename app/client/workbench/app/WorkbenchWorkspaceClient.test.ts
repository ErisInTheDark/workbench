/* No production exports. Protect partial queries, shared demand and stale-result fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import { workspaceObservationShape } from "workbench-shared/workbench/workspace/workspace-observation";
import { diffObservationValue } from "workbench-shared/workbench/workspace/observation-patch";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";

test("working-tree summary crosses the workspace socket with its folder scope and validates replies", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const location = {
    daemonId: DaemonIdSchema.parse("00000001-0000-4000-8000-000000000000"),
    projectId: ProjectIdSchema.parse("folder"),
  };
  const daemon = fixture.workspace.daemon({ kind: "folder", location });
  const read = daemon.git.workingTree.summary({ projectId: location.projectId });
  const rejected = read.catch(error => error);
  await Promise.resolve();
  const request = socket.sent.find(item => item.method === "workspace/command"
    && item.params.method === "git/working-tree/summary");
  assert.ok(request?.method === "workspace/command");
  assert.deepEqual(request.params.scope, { kind: "folder", location });
  const summary = { repositories: [{ rootId: "root", label: "folder", dirty: true }], errors: [] };
  socket.reply(request, summary);
  assert.deepEqual(await read, summary);
  await rejected;

  const errors: string[] = [];
  context.mock.method(console, "error", (message: string) => errors.push(message));
  const invalid = daemon.git.workingTree.summary({ projectId: location.projectId });
  const invalidResult = assert.rejects(invalid);
  const next = await socket.request("workspace/command", socket.sent.indexOf(request) + 1);
  socket.reply(next, { repositories: [{ rootId: "root", label: "folder", dirty: "invalid" }], errors: [] });
  await invalidResult;
  assert.ok(errors.length > 0);
});

test("auto-compaction settings cross the workspace facade to the selected daemon and validate replies", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const daemonId = DaemonIdSchema.parse("00000001-0000-4000-8000-000000000000");
  const daemon = fixture.workspace.daemon({ kind: "installation", daemonId });
  const read = daemon.threadAutoCompact.read();
  const request = await Promise.race([
    socket.request("workspace/command"),
    read.then(() => assert.fail("settings resolved before the workspace replied")),
  ]);
  assert.deepEqual(request.params.scope, { kind: "installation", daemonId });
  socket.reply(request, { settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS });
  assert.deepEqual(await read, { settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS });
  const patch = { tokenThreshold: 250_000, enabled: false };
  const update = daemon.threadAutoCompact.update({ settings: patch });
  const next = await socket.request("workspace/command", socket.sent.indexOf(request) + 1);
  assert.deepEqual(next.params.scope, { kind: "installation", daemonId });
  assert.deepEqual(next.params.params, { settings: patch });
  socket.reply(next, { settings: { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS, ...patch } });
  assert.deepEqual((await update).settings, { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS, ...patch });
});

const runtime = {
  kind: "runtime" as const, phase: "current" as const, failure: null,
  data: { frontendGeneration: null, reloadDirt: { dirtyScopes: [], pendingScopes: [], error: null } },
};

test("an available query publishes while an unrelated query remains pending", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const blocked = fixture.workspace.observe({ kind: "network" });
  const ready = fixture.workspace.observe({ kind: "runtime" });
  const request = socket.sent.find(item => item.method === "workspace/observe" && item.params.query.kind === "runtime");
  assert.ok(request?.method === "workspace/observe");
  await socket.observation(request, runtime, 1, true);
  await fixture.workspace.waitFor(ready);
  assert.equal(ready.getSnapshot().phase, "current");
  assert.equal(blocked.getSnapshot().phase, "pending");
  assert.equal(blocked.getSnapshot().value, null);
});

test("matching interests share work and releasing one does not retire the other", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  let publications = 0;
  const first = fixture.workspace.observe({ kind: "runtime" });
  const second = fixture.workspace.observe({ kind: "runtime" }, () => publications++);
  const request = await socket.request("workspace/observe");
  assert.equal(socket.sent.filter(item => item.method === "workspace/observe").length, 1);
  await socket.observation(request, runtime);
  const accepted = second.getSnapshot();
  const count = publications;
  await socket.observation(request, runtime);
  assert.equal(second.getSnapshot(), accepted);
  assert.equal(publications, count);
  first.release();
  assert.equal(socket.sent.filter(item => item.method === "workspace/release").length, 0);
  await socket.observation(request, { ...runtime, data: { ...runtime.data,
    reloadDirt: { ...runtime.data.reloadDirt, error: "reload failed" } } }, 2);
  assert.equal(second.getSnapshot().value?.data?.reloadDirt.error, "reload failed");
  second.release();
  assert.equal(socket.sent.filter(item => item.method === "workspace/release").length, 1);
});

test("app deltas update the exact retained value and a gap re-observes instead of guessing", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const query = fixture.workspace.observe({ kind: "runtime" });
  const request = await socket.request("workspace/observe");
  await socket.observation(request, runtime, 1, true);
  await fixture.workspace.waitFor(query);
  const address = { subscriptionId: request.params.subscriptionId, generation: request.params.generation, kind: "runtime" };
  const failed = { ...runtime.data, reloadDirt: { ...runtime.data.reloadDirt, error: "reload failed" as string | null } };
  const delta = (baseRevision: number, from: object, to: object) => ({ kind: "workspaceDelta" as const, delta: {
    ...address, baseRevision, revision: baseRevision + 1,
    delta: diffObservationValue({ ...runtime, ...address, revision: baseRevision, data: from },
      { ...runtime, ...address, revision: baseRevision, data: to }, workspaceObservationShape("runtime"))!,
  } });
  socket.event(delta(1, runtime.data, failed));
  assert.equal(query.getSnapshot().value?.data?.reloadDirt.error, "reload failed");
  assert.equal(query.getSnapshot().value?.revision, 2);
  const offset = socket.sent.length;
  socket.event(delta(5, failed, runtime.data));
  const reobserved = await socket.request("workspace/observe", offset);
  assert.equal(reobserved.params.subscriptionId, request.params.subscriptionId);
  assert.equal(query.getSnapshot().value?.data?.reloadDirt.error, "reload failed");
  assert.match(warnings.join("\n"), /runtime observation resync/u);
});

test("replaced interest ignores a delayed acknowledgement and cancels its waiter", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const first = fixture.workspace.observe({ kind: "runtime" });
  const old = await socket.request("workspace/observe");
  const rejected = assert.rejects(fixture.workspace.waitFor(first));
  first.release();
  await rejected;
  const offset = socket.sent.length;
  const replacement = fixture.workspace.observe({ kind: "runtime" });
  const current = await socket.request("workspace/observe", offset);
  await socket.observation(current, runtime);
  const accepted = replacement.getSnapshot();
  await socket.observation(old, { ...runtime, phase: "failed", failure: "old query failed", data: null }, 99, true);
  assert.equal(replacement.getSnapshot(), accepted);
});

test("reconnect retains facts as stale, restores reads and fences the old generation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const query = fixture.workspace.observe({ kind: "runtime" });
  const initial = await socket.request("workspace/observe");
  await socket.observation(initial, runtime);
  socket.reply(initial, { malformedRetiredReply: true });
  socket.close();
  assert.equal(query.getSnapshot().phase, "stale");
  assert.ok(query.getSnapshot().value?.data);
  context.mock.timers.tick(60_000);
  const next = await fixture.nextSocket(1);
  const connected = fixture.workspace.connect();
  next.open();
  await connected;
  const restored = await next.request("workspace/observe");
  assert.ok(restored.params.generation > initial.params.generation);
  const stale = query.getSnapshot();
  await next.observation(initial, { ...runtime, phase: "failed", failure: "retired", data: null }, 100);
  assert.equal(query.getSnapshot(), stale);
  await next.observation(restored, runtime);
  assert.equal(query.getSnapshot().phase, "current");
  assert.equal(query.getSnapshot().failure, null);
});

test("bad pushed data fails only its current query and retains its last good facts", async context => {
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const query = fixture.workspace.observe({ kind: "runtime" });
  const other = fixture.workspace.observe({ kind: "network" });
  const request = await socket.request("workspace/observe");
  const invalid = (generation = request.params.generation) => socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ kind: "workspaceDelta", delta: {
      subscriptionId: request.params.subscriptionId, generation, kind: "runtime", baseRevision: 1, revision: 2, delta: "invalid",
    } }),
  }));
  invalid();
  assert.equal(query.getSnapshot().phase, "failed");
  await assert.rejects(fixture.workspace.waitFor(query), /invalid/u);
  assert.equal(other.getSnapshot().phase, "pending");
  await socket.observation(request, runtime);
  const value = query.getSnapshot().value;
  invalid();
  assert.equal(query.getSnapshot().phase, "stale");
  assert.equal(query.getSnapshot().value, value);
  await socket.observation(request, runtime, 2);
  const restored = query.getSnapshot();
  invalid(request.params.generation - 1);
  assert.equal(query.getSnapshot(), restored);
  await socket.observation(request, { kind: "network", phase: "pending", failure: null, data: null }, 3);
  assert.equal(query.getSnapshot().phase, "stale");
  assert.equal(query.getSnapshot().value, restored.value);
});
