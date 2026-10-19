/* No production exports. Protect partial queries, shared demand, stale-result fencing, connection-waiting requests and thread-command identity. */
import assert from "node:assert/strict";
import test from "node:test";
import { workspaceObservationShape } from "workbench-shared/workbench/workspace/workspace-observation";
import { diffObservationValue } from "workbench-shared/workbench/workspace/observation-patch";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";
import { DaemonIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";

test("working-tree reads cross the workspace socket with their folder scope and validate replies", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const location = {
    daemonId: DaemonIdSchema.parse("00000001-0000-4000-8000-000000000000"),
    projectId: ProjectIdSchema.parse("folder"),
  };
  const daemon = fixture.workspace.daemon({ kind: "folder", location });
  const read = daemon.git.workingTree.read({ projectId: location.projectId });
  const rejected = read.catch((error: unknown) => error);
  await Promise.resolve();
  const request = socket.sent.find(item => item.method === "workspace/command"
    && item.params.method === "git/working-tree/read");
  assert.ok(request?.method === "workspace/command");
  assert.deepEqual(request.params.scope, { kind: "folder", location });
  const tree = { repositories: [], errors: [] };
  socket.reply(request, tree);
  assert.deepEqual(await read, tree);
  await rejected;

  const errors: string[] = [];
  context.mock.method(console, "error", (message: string) => errors.push(message));
  const invalid = daemon.git.workingTree.read({ projectId: location.projectId });
  const invalidResult = assert.rejects(invalid);
  const next = await socket.request("workspace/command", socket.sent.indexOf(request) + 1);
  socket.reply(next, { repositories: "invalid", errors: [] });
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

test("thread-scoped commands keep the identity they name and fall back to the scope thread", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const parent = ThreadReferenceSchema.parse("00000000-0000-4000-8000-0000000000a1");
  const child = ThreadReferenceSchema.parse("00000000-0000-4000-8000-0000000000b2");
  const daemon = fixture.workspace.daemon({ kind: "thread", threadId: parent });
  const discard = daemon.git.arc.discardStash({ cwd: "C:/repo", harness: "codex", threadId: child });
  const request = await socket.request("workspace/command");
  assert.equal(request.params.method, "git/arc/stash/discard");
  assert.equal(request.params.params.threadId, child);
  socket.reply(request, { ok: true });
  await discard;

  const sessions = daemon.browse.sessions.read({});
  const browse = await socket.request("workspace/command", socket.sent.indexOf(request) + 1);
  assert.equal(browse.params.params.threadId, parent);
  socket.reply(browse, { sessions: [] });
  await sessions;
});

test("daemon requests made before the app connection opens are sent once it opens", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  fixture.rpc.start();
  const socket = await fixture.nextSocket(0);
  const read = fixture.workspace.daemon().threadAutoCompact.read();
  for (let hop = 0; hop < 20; hop++) await Promise.resolve();
  assert.equal(socket.sent.length, 0);
  socket.open();
  const request = await socket.request("workspace/command");
  socket.reply(request, { settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS });
  assert.deepEqual(await read, { settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS });
});

test("closing the workspace releases requests still waiting for a connection", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  fixture.rpc.start();
  const socket = await fixture.nextSocket(0);
  const read = fixture.workspace.daemon().threadAutoCompact.read();
  fixture.workspace.dispose();
  await assert.rejects(read, /Workspace client closed/u);
  assert.equal(socket.sent.length, 0);
});

const runtime = {
  kind: "runtime" as const, phase: "current" as const, failure: null,
  data: { frontendGeneration: null, reloadDirt: { dirtyScopes: [], pendingScopes: [], error: null } },
};

test("file facts survive a pending replacement without being reported as current", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const location = { daemonId: DaemonIdSchema.parse("00000001-0000-4000-8000-000000000000"),
    projectId: ProjectIdSchema.parse("folder") };
  const handle = fixture.workspace.observe({ kind: "projectFile", location, path: "notes.md" });
  const request = await socket.request("workspace/observe");
  const data = { projectId: location.projectId, path: "notes.md", content: "keep", headContent: null,
    mtimeMs: 1, updatedAt: new Date(1).toISOString(), changeSummary: null };
  await socket.observation(request, { kind: "projectFile", phase: "current", failure: null, data });
  await socket.observation(request, { kind: "projectFile", phase: "pending", failure: null, data: null }, 2);
  assert.equal(handle.getSnapshot().phase, "pending");
  assert.equal(handle.getSnapshot().value?.data?.content, "keep");
  await socket.observation(request, { kind: "projectFile", phase: "current", failure: null,
    data: { ...data, content: "fresh", mtimeMs: 2 } }, 3);
  assert.equal(handle.getSnapshot().value?.data?.content, "fresh");
});

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
  await Promise.resolve();
  assert.equal(socket.sent.filter(item => item.method === "workspace/release").length, 1);
});

test("a query re-observed during its release grace keeps the held value, and only expiry releases it once", async context => {
  const graces: Array<{ expire(): void; cancelled: boolean }> = [];
  const expire = () => { for (const grace of graces.splice(0)) if (!grace.cancelled) grace.expire(); };
  const fixture = createWorkspaceClientFixture({ linger: run => {
    const grace = { expire: run, cancelled: false };
    graces.push(grace);
    return () => { grace.cancelled = true; };
  } });
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const first = fixture.workspace.observe({ kind: "runtime" });
  const request = await socket.request("workspace/observe");
  await socket.observation(request, runtime);
  const held = first.getSnapshot();
  const offset = socket.sent.length;
  first.release();
  for (let hop = 0; hop < 20; hop++) await Promise.resolve();
  const second = fixture.workspace.observe({ kind: "runtime" });
  assert.equal(second.getSnapshot(), held);
  expire();
  assert.equal(socket.sent.length, offset, "the returning observer neither releases nor observes again");
  second.release();
  expire();
  expire();
  assert.deepEqual(socket.sent.slice(offset).map(item => item.method), ["workspace/release"]);
});

test("a summary batch retargets by id patch; a rejected patch resends the whole query, then a fresh subscription", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const [first, second, third] = ["00000001", "00000002", "00000003"].map(prefix => ThreadReferenceSchema.parse(`${prefix}-0000-4000-8000-000000000000`));
  const handle = fixture.workspace.observe({ kind: "threadSummaries", threadIds: [first] });
  const opened = await socket.request("workspace/observe");
  await socket.observation(opened, { kind: "threadSummaries", phase: "current", failure: null, data: {} }, 1, true);
  const offset = socket.sent.length;
  handle.retarget({ kind: "threadSummaries", threadIds: [first, second] });
  const patched = await socket.request("workspace/retarget", offset);
  assert.equal(patched.params.subscriptionId, opened.params.subscriptionId);
  assert.deepEqual("patch" in patched.params && patched.params.patch, { kind: "threadSummaries", add: [second], remove: [] });

  // An older app rejects the patch; the whole query resynchronises it and later retargets stop patching.
  const wholeOffset = socket.sent.length;
  socket.fail(patched, "Invalid request.", -32600);
  const whole = await socket.request("workspace/retarget", wholeOffset);
  assert.deepEqual("query" in whole.params && whole.params.query, { kind: "threadSummaries", threadIds: [first, second] });
  socket.reply(whole, { revision: 1 });
  const laterOffset = socket.sent.length;
  handle.retarget({ kind: "threadSummaries", threadIds: [first, second, third] });
  const later = await socket.request("workspace/retarget", laterOffset);
  assert.ok("query" in later.params, "a connection that rejected a patch keeps sending whole queries");

  const fallbackOffset = socket.sent.length;
  socket.fail(later, "Invalid request.", -32600);
  const reopened = await socket.request("workspace/observe", fallbackOffset);
  assert.notEqual(reopened.params.subscriptionId, opened.params.subscriptionId);
  assert.deepEqual(reopened.params.query, { kind: "threadSummaries", threadIds: [first, second, third] });
  assert.ok(socket.sent.slice(fallbackOffset).some(message => message.method === "workspace/release"
    && message.params.subscriptionId === opened.params.subscriptionId), "the old subscription is released");
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

test("snapshot repairs preserve sibling rows but a lossy delta retains its base and requests a fresh value", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const handle = fixture.workspace.observe({ kind: "runtime" });
  const request = await socket.request("workspace/observe");
  const scope = { scope: "client:workspace", description: "workspace", dependantScopes: [], destructive: false };
  socket.reply(request, {
    ...runtime, subscriptionId: request.params.subscriptionId, generation: request.params.generation, revision: 1,
    data: { ...runtime.data, reloadDirt: { ...runtime.data.reloadDirt,
      dirtyScopes: [{ ...scope, future: "private-value" }, { ...scope, scope: 3 }] } },
  });
  await fixture.workspace.waitFor(handle);
  assert.deepEqual(handle.getSnapshot().value?.data?.reloadDirt.dirtyScopes, [scope]);
  const address = { subscriptionId: request.params.subscriptionId, generation: request.params.generation,
    kind: "runtime", baseRevision: 1, revision: 2 };
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    kind: "workspaceDelta", delta: { ...address, future: true, delta: {
      set: { data: { ...runtime.data, reloadDirt: { ...runtime.data.reloadDirt, dirtyScopes: [{ ...scope, future: true }] } } },
    } },
  }) }));
  assert.equal(handle.getSnapshot().value?.revision, 2);
  assert.deepEqual(handle.getSnapshot().value?.data?.reloadDirt.dirtyScopes, [scope]);
  const accepted = handle.getSnapshot().value;
  const offset = socket.sent.length;
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    kind: "workspaceDelta", delta: { ...address, baseRevision: 2, revision: 3, delta: {
      set: { data: { ...runtime.data, reloadDirt: { ...runtime.data.reloadDirt, dirtyScopes: [{ ...scope, scope: 3 }] } } },
    } },
  }) }));
  assert.equal(handle.getSnapshot().value, accepted);
  const reobserved = await socket.request("workspace/observe", offset);
  assert.equal(reobserved.params.subscriptionId, request.params.subscriptionId);
  assert.ok(warnings.some(message => message.includes("dirtyScopes")));
  assert.ok(!warnings.join("\n").includes("private-value"));
});

test("app-state observations return conformed tables rather than the original predicate-accepted payload", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const handle = fixture.workspace.observe({ kind: "appState", browserStateId: null });
  const request = await socket.request("workspace/observe");
  socket.reply(request, {
    kind: "appState", subscriptionId: request.params.subscriptionId, generation: request.params.generation,
    revision: 1, phase: "current", failure: null,
    data: { kind: "snapshot", daemonRegistrationId: "registration", revision: 4, oldestAvailableRevision: 0,
      rows: { future: [{ secret: "private-value" }] } },
  });
  await fixture.workspace.waitFor(handle);
  const data = handle.getSnapshot().value?.data;
  assert.ok(data);
  assert.equal(data.revision, 4);
  assert.equal(data.daemonRegistrationId, "registration");
  assert.equal(Object.hasOwn(data.rows, "future"), false);
  assert.ok(Object.keys(data.rows).length > 0);
  assert.ok(warnings.some(message => message.includes("data.rows.future")));
  assert.ok(!warnings.join("\n").includes("private-value"));
  const offset = socket.sent.length;
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    kind: "workspaceDelta", delta: {
      subscriptionId: request.params.subscriptionId, generation: request.params.generation,
      kind: "appState", baseRevision: 1, revision: 2,
      delta: { set: { data: { ...data, revision: 5, future: "private-value" } } },
    },
  }) }));
  assert.equal(handle.getSnapshot().value?.revision, 2, "harmless app-state drift must not trigger a resync");
  assert.equal(handle.getSnapshot().value?.data?.revision, 5);
  assert.equal(Object.hasOwn(handle.getSnapshot().value?.data ?? {}, "future"), false);
  assert.equal(socket.sent.length, offset);
  const beforeLoss = handle.getSnapshot().value;
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    kind: "workspaceDelta", delta: {
      subscriptionId: request.params.subscriptionId, generation: request.params.generation,
      kind: "appState", baseRevision: 2, revision: 3,
      delta: { set: { data: { ...data, revision: 6,
        rows: { ...data.rows, globalPreferences: [{ key: "future-preference", revision: 6 }] } } } },
    },
  }) }));
  assert.equal(handle.getSnapshot().value, beforeLoss, "dropping an unknown preference row requires a fresh baseline");
  const reopened = await socket.request("workspace/observe", offset);
  assert.equal(reopened.params.subscriptionId, request.params.subscriptionId);
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
  const pending = fixture.workspace.observe({ kind: "network" });
  const initial = await socket.request("workspace/observe");
  await socket.observation(initial, runtime);
  socket.reply(initial, { malformedRetiredReply: true });
  socket.close();
  assert.equal(query.getSnapshot().phase, "stale");
  assert.ok(query.getSnapshot().value?.data);
  assert.equal(query.getSnapshot().failure, null);
  assert.deepEqual(pending.getSnapshot(), { phase: "pending", failure: null, value: null });
  assert.ok(fixture.workspace.rpc.getSnapshot().failure);
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
