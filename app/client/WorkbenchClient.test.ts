/* No production exports. Protect independent local-folder rendering, draft-preserving registration and applied launch identity. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExplorerSnapshot, WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkspaceProjects, WorkspaceThreadRows } from "workbench-shared/workbench/workspace/workspace-observation";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { createHomeRoute, createLogicalExistingThreadRoute, createLogicalProjectRoute, createLogicalThreadRoute, createProjectSelectionRoute, createSettingsRoute, withProjectSelection } from "workbench-shared/workbench/navigation/workbench-route";
import { createWorkspaceClientFixture } from "./workbench/app/workspace-client-fixture";
import { WorkbenchClient } from "./WorkbenchClient";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const blockedId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
const logicalId = LogicalProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
const project: WorkbenchProjectOption = {
  id: ProjectIdSchema.parse("local://C:/git/app/bak"), kind: "git", name: "bak",
  rootPath: "C:/git/app/bak", relativePath: "bak", lastCommitTimeMs: null,
  roots: [{ id: "root", isPrimary: true, name: "bak", rootPath: "C:/git/app/bak", relativePath: "" }],
};
const location = { daemonId, projectId: project.id };
function facts(registered: boolean): WorkspaceProjects {
  return {
    projects: registered ? [{
      id: logicalId, label: "bak", matchKey: "local://C:/git/app/bak",
      locations: [{ target: location, daemonId, hostname: "local", name: "bak",
        rootPath: project.rootPath, project }],
    }] : [],
    observedProjects: registered ? [] : [{
      identityKey: ProjectIdentityKeySchema.parse("local://C:/git/app/bak"),
      locations: [{ location, hostname: "local", project }], registrationFailure: null,
    }],
    summaries: {}, navigation: [],
    sources: [
      { daemonId, hostname: "local", connection: "current", generation: 1, failure: null },
      { daemonId: blockedId, hostname: "blocked", connection: "connecting", generation: 0, failure: null },
    ],
    catalogues: [
      { daemonId, phase: "current", failure: null },
      { daemonId: blockedId, phase: "pending", failure: null },
    ],
  };
}

test("empty and multi-project list routes do not invent a browsed folder", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  for (const selected of [[], [logicalId, "another-project"]]) {
    const result = await client.controls.applyRoute(createProjectSelectionRoute(selected));
    assert.equal(result.ok, true);
    assert.deepEqual(client.navigation.getSnapshot().route.selectedProjectIds, selected);
  }
  assert.equal(socket.sent.some(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectTree"), false);
});

test("settings keeps zero, one or many selected logical projects without browsing a physical folder", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  for (const selected of [[], [logicalId], [logicalId, "another-project"]]) {
    const route = withProjectSelection(createSettingsRoute(""), selected);
    assert.equal((await client.controls.applyRoute(route)).ok, true);
    assert.deepEqual(client.navigation.getSnapshot().route.selectedProjectIds, selected);
  }
  assert.equal(socket.sent.some(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectTree"), false);
});

test("mounted project navigation keeps its identity while project facts change", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const navigator = client.projectNavigator;
  const route = createLogicalProjectRoute(logicalId);
  assert.equal(navigator.href(route), undefined);

  const query = await socket.request("workspace/observe", 0,
    request => request.params.query.kind === "projects");
  socket.observation(query, { kind: "projects", phase: "current", failure: null, data: facts(true) });
  assert.equal(client.projectNavigator, navigator);
  assert.equal(navigator.href(route), "/bak/@/");

  const renamed = facts(true);
  renamed.projects[0] = { ...renamed.projects[0]!, matchKey: "remote://github.com/team/renamed",
    locations: [] };
  socket.observation(query, { kind: "projects", phase: "current", failure: null, data: renamed }, 2);
  assert.equal(client.projectNavigator, navigator);
  assert.equal(navigator.href(route), "/renamed/@/");
});

test("project row observations hand off without blanking visible threads", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const snapshots: ExplorerSnapshot[] = [];
  const client = WorkbenchClient({
    workspace: fixture.workspace,
    onExplorerStateChange: snapshot => snapshots.push(snapshot),
  });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const secondId = LogicalProjectIdSchema.parse("00000000-0000-4000-8000-000000000004");
  const secondLocation = { daemonId, projectId: ProjectIdSchema.parse("local://C:/git/app/other") };
  const data = facts(true);
  data.projects.push({
    ...data.projects[0]!, id: secondId, label: "other", matchKey: "local://C:/git/app/other",
    locations: [{ ...data.projects[0]!.locations[0]!, target: secondLocation,
      name: "other", rootPath: "C:/git/app/other",
      project: { ...project, id: secondLocation.projectId, name: "other",
        relativePath: "other", rootPath: "C:/git/app/other" } }],
  });
  const projects = await socket.request("workspace/observe", 0,
    request => request.params.query.kind === "projects");
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data });

  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId))).ok, true);
  const firstQuery = await socket.request("workspace/observe", 0, request =>
    request.params.query.kind === "projectThreads" && request.params.query.projects?.length === 1);
  const firstRow = {
    logicalProjectId: logicalId, location, hostname: "local", rootPath: project.rootPath,
    entry: {
      entryKind: "thread" as const, title: "first", activityAt: 1,
      identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("first") },
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false },
    },
  } satisfies WorkspaceThreadRows["rows"][number];
  socket.observation(firstQuery, { kind: "projectThreads", phase: "current", failure: null,
    data: { rows: [firstRow], projects: [] } });
  await Promise.resolve();
  assert.deepEqual(snapshots.at(-1)?.logicalThreads?.map(row => row.entry.title), ["first"]);

  const beforeAdd = socket.sent.length;
  assert.equal((await client.controls.applyRoute(withProjectSelection(createLogicalProjectRoute(logicalId),
    [logicalId, secondId]))).ok, true);
  const added = await socket.request("workspace/observe", beforeAdd, request =>
    request.params.query.kind === "projectThreads" && request.params.query.projects?.length === 2);
  socket.observation(added, { kind: "projectThreads", phase: "pending", failure: null,
    data: { rows: [], projects: [] } });
  await Promise.resolve();
  assert.deepEqual(snapshots.at(-1)?.logicalThreads?.map(row => row.entry.title), ["first"]);
  assert.equal(socket.sent.some(item => item.method === "workspace/release"
    && item.params.subscriptionId === firstQuery.params.subscriptionId), false);

  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId))).ok, true);
  const superseded = await socket.request("workspace/release", beforeAdd,
    request => request.params.subscriptionId === added.params.subscriptionId);
  assert.equal(superseded.params.subscriptionId, added.params.subscriptionId);
  assert.deepEqual(snapshots.at(-1)?.logicalThreads?.map(row => row.entry.title), ["first"]);

  const beforeRetry = socket.sent.length;
  assert.equal((await client.controls.applyRoute(withProjectSelection(createLogicalProjectRoute(logicalId),
    [logicalId, secondId]))).ok, true);
  const retry = await socket.request("workspace/observe", beforeRetry, request =>
    request.params.query.kind === "projectThreads" && request.params.query.projects?.length === 2);
  const secondRow = {
    ...firstRow, logicalProjectId: secondId, location: secondLocation, rootPath: "C:/git/app/other",
    entry: { ...firstRow.entry, title: "second",
      identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("second") } },
  } satisfies WorkspaceThreadRows["rows"][number];
  socket.observation(retry, { kind: "projectThreads", phase: "current", failure: null,
    data: { rows: [firstRow, secondRow], projects: [] } });
  await socket.request("workspace/release", beforeRetry,
    request => request.params.subscriptionId === firstQuery.params.subscriptionId);
  assert.deepEqual(snapshots.at(-1)?.logicalThreads?.map(row => row.entry.title), ["first", "second"]);

  const beforeFailure = socket.sent.length;
  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId))).ok, true);
  const failing = await socket.request("workspace/observe", beforeFailure, request =>
    request.params.query.kind === "projectThreads" && request.params.query.projects?.length === 1);
  socket.fail(failing, "project rows unavailable");
  await socket.request("workspace/release", beforeFailure,
    request => request.params.subscriptionId === retry.params.subscriptionId);
  await Promise.resolve();
  assert.deepEqual(snapshots.at(-1)?.logicalThreads, []);
  assert.match(snapshots.at(-1)?.threadsError ?? "", /project rows unavailable/);
  assert.ok(warnings.some(message => message.includes("Workspace query failed")));
});

test("composing from the default project list keeps row demand on every project", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0,
    request => request.params.query.kind === "projects");
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data: facts(true) });
  const offset = socket.sent.length;
  await client.controls.applyRoute(createLogicalThreadRoute(null, logicalId, location, { kind: "new" }));
  const scoped = socket.sent.slice(offset).filter(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectThreads" && item.params.query.projects !== null);
  assert.deepEqual(scoped.map(item => item.method === "workspace/observe" && item.params.query), []);
});

test("an older app broadens row demand only when project groups are unavailable", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0,
    request => request.params.query.kind === "projects");
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data: facts(true) });
  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId))).ok, true);
  const focused = await socket.request("workspace/observe", 0,
    request => request.params.query.kind === "projectThreads"
      && request.params.query.projects?.length === 1);
  assert.equal(focused.params.query.kind, "projectThreads");
  const groups = await socket.request("workspace/observe", 0,
    request => request.params.query.kind === "projectGroups");
  const offset = socket.sent.length;
  socket.fail(groups, "Unknown query kind");
  const fallback = await socket.request("workspace/observe", offset,
    request => request.params.query.kind === "projectThreads" && request.params.query.projects === null);
  assert.equal(fallback.params.query.kind, "projectThreads");
  if (fallback.params.query.kind === "projectThreads") assert.equal(fallback.params.query.projects, null);
  assert.ok(warnings.some(message => message.includes("Workspace query failed")));
});

test("a no-remote folder opens a draft while another source and unrelated app queries remain pending", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const query = socket.sent.find(item => item.method === "workspace/observe" && item.params.query.kind === "projects");
  assert.ok(query?.method === "workspace/observe");
  socket.observation(query, { kind: "projects", phase: "stale", failure: null, data: facts(true) });
  const route = createLogicalThreadRoute(null, logicalId, location, { kind: "new" });
  assert.equal((await client.controls.applyRoute(route)).ok, true);
  assert.equal(client.navigation.getSnapshot().route.logical?.projectId, null);
  const draft = client.threadRuntime.getSnapshot().currentThread;
  assert.ok(draft?.isDraft);
  assert.equal(draft.cwd, project.rootPath);
  assert.deepEqual(client.draftLocationFor(draft.id), location);
  assert.equal(client.navigation.getSnapshot().error, null);
  const tree = socket.sent.find(item => item.method === "workspace/observe" && item.params.query.kind === "projectTree");
  assert.ok(tree?.method === "workspace/observe");
  assert.deepEqual(tree.params.query, { kind: "projectTree", location });

  const reading = client.controls.listModels("codex");
  const models = await socket.request("workspace/command", 0, request => request.params.method === "models/list"
    && request.params.params?.provider === "codex");
  socket.reply(models, { data: [] });
  await reading;
  const next = facts(true);
  next.sources[0]!.generation++;
  const offset = socket.sent.length;
  socket.observation(query, { kind: "projects", phase: "stale", failure: null, data: next }, 2);
  assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, draft.id);
  const refreshed = client.controls.listModels("codex");
  const reloaded = await socket.request("workspace/command", offset, request => request.params.method === "models/list"
    && request.params.params?.provider === "codex");
  socket.reply(reloaded, { data: [] });
  await refreshed;
  assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, draft.id);
});

test("new-thread views warm opencode on their own daemon before provider selection", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data: facts(true) });
  assert.equal((await client.controls.applyRoute(createLogicalThreadRoute(logicalId, logicalId, location, { kind: "new" }))).ok, true);
  const warming = await socket.request("workspace/command", 0, request => request.params.method === "models/list"
    && request.params.params?.provider === "opencode");
  assert.deepEqual(warming.params.scope, { kind: "installation", daemonId });
  socket.event({ kind: "threadEvent", notification: { method: "models/updated", params: {} }, harness: "opencode", daemonId });
  socket.reply(warming, { data: [] });
  await Promise.resolve();
  assert.equal(warnings.some(message => message.includes("warm OpenCode models")), false);
  const beforeReconnect = socket.sent.length;
  const reconnected = facts(true);
  reconnected.sources[0]!.generation++;
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data: reconnected }, 2);
  const warmingAgain = await socket.request("workspace/command", beforeReconnect,
    request => request.params.method === "models/list" && request.params.params?.provider === "opencode");
  assert.deepEqual(warmingAgain.params.scope, { kind: "installation", daemonId });
  socket.reply(warmingAgain, { data: [] });
});

test("observed unsettled opencode threads warm their source but settled and codex rows do not", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data: facts(true) });
  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId))).ok, true);
  const rows = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projectThreads"
    && request.params.query.projects?.length === 1);
  const base = {
    logicalProjectId: logicalId, location, hostname: "local", rootPath: project.rootPath,
    entry: {
      entryKind: "thread" as const, title: "thread", activityAt: 1,
      identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("thread") },
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false },
    },
  } satisfies WorkspaceThreadRows["rows"][number];
  socket.observation(rows, { kind: "projectThreads", phase: "current", failure: null,
    data: { rows: [base, { ...base, entry: { ...base.entry,
      identity: { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("settled") },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true } } }], projects: [] } });
  await Promise.resolve();
  assert.equal(socket.sent.some(request => request.method === "workspace/command"
    && request.params.method === "models/list" && request.params.params?.provider === "opencode"), false);
  socket.observation(rows, { kind: "projectThreads", phase: "current", failure: null,
    data: { rows: [{ ...base, entry: { ...base.entry,
      identity: { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("unsettled") } } }], projects: [] } }, 2);
  const warming = await socket.request("workspace/command", 0, request => request.params.method === "models/list"
    && request.params.params?.provider === "opencode");
  assert.deepEqual(warming.params.scope, { kind: "installation", daemonId });
  socket.reply(warming, { data: [] });
});

test("a registered offline folder can open a draft without claiming live explorer metadata", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  data.projects[0]!.locations[0]!.project = null;
  data.sources[0]!.connection = "connecting";
  data.catalogues[0]!.phase = "pending";
  socket.observation(query, { kind: "projects", phase: "stale", failure: null, data });
  const result = await client.controls.applyRoute(createLogicalThreadRoute(logicalId, logicalId, location, { kind: "new" }));
  assert.equal(result.ok, true);
  const draft = client.threadRuntime.getSnapshot().currentThread;
  assert.ok(draft?.isDraft);
  assert.equal(draft.cwd, project.rootPath);
  assert.deepEqual(client.draftLocationFor(draft.id), location);
  assert.equal(client.draftContextFor(draft.id)?.daemonId, daemonId);
  assert.deepEqual(client.draftContextFor(draft.id)?.project.roots, []);
  const tree = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projectTree");
  assert.deepEqual(tree.params.query, { kind: "projectTree", location });
});

test("a multi-folder project does not browse a preferred or arbitrary folder", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  const other = { daemonId, projectId: ProjectIdSchema.parse("other-folder") };
  data.projects[0]!.locations[0]!.displayPath = "workbench";
  data.projects[0]!.locations.push({
    target: other, daemonId, hostname: "local", name: "convex-lab",
    rootPath: "C:/git/web/workbench/.workbench/worktrees/convex-lab",
    displayPath: "+convex-lab", project: { ...project, id: other.projectId, name: "convex-lab" },
  });
  socket.observation(query, { kind: "projects", phase: "current", failure: null, data });

  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId))).ok, true);
  assert.equal(socket.sent.some(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectTree"), false);

  assert.equal((await client.controls.applyRoute(createLogicalProjectRoute(logicalId, location))).ok, true);
  assert.ok(socket.sent.some(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectTree"));
});

test("a preferred draft destination does not become a multi-folder browse selection", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  data.projects[0]!.locations.push({
    target: { daemonId, projectId: ProjectIdSchema.parse("other-folder") },
    daemonId, hostname: "local", name: "convex-lab",
    rootPath: "C:/git/web/workbench/.workbench/worktrees/convex-lab",
    project: null,
  });
  socket.observation(query, { kind: "projects", phase: "current", failure: null, data });

  assert.equal((await client.controls.applyRoute(
    createLogicalThreadRoute(logicalId, logicalId, null, { kind: "new" }),
  )).ok, true);
  const draft = client.threadRuntime.getSnapshot().currentThread;
  assert.ok(draft?.isDraft);
  assert.deepEqual(client.draftLocationFor(draft.id), location);
  assert.equal(client.navigation.getSnapshot().route.logical?.location, null);
  assert.equal(socket.sent.some(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectTree"), false);
});

test("a thread owner uses its projected folder label", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  data.projects[0]!.locations[0]!.displayPath = "workbench";
  data.projects[0]!.locations.push({
    target: { daemonId, projectId: ProjectIdSchema.parse("other-folder") },
    daemonId, hostname: "local", name: "convex-lab",
    rootPath: "C:/git/web/workbench/.workbench/worktrees/convex-lab",
    displayPath: "+convex-lab", project: null,
  });
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data });
  const threadId = WorkbenchThreadIdSchema.parse(crypto.randomUUID());
  const route = createLogicalExistingThreadRoute(logicalId,
    { kind: "provider", harness: "codex", threadId }, null);
  assert.equal((await client.controls.applyRoute(route)).pending, true);
  const owner = await socket.request("workspace/observe", 0, request => request.params.query.kind === "threadOwner");
  socket.observation(owner, { kind: "threadOwner", phase: "current", failure: null, data: {
    phase: "current", identity: { threadId, projectId: project.id, harness: "codex" },
    location, logicalProjectId: logicalId,
  } });
  const opening = client.controls.applyRoute(route);
  const read = await socket.request("workspace/observe", 0, request => request.params.query.kind === "thread");
  assert.equal(client.threadOwnerFor(threadId)?.displayPath, "workbench");
  assert.equal(socket.sent.some(item => item.method === "workspace/observe"
    && item.params.query.kind === "projectTree"), false);
  await client.controls.applyRoute(createHomeRoute());
  socket.observation(read, { kind: "thread", phase: "failed", failure: "source read unavailable",
    data: null, owner: { phase: "unavailable", failure: "source read unavailable" } });
  await opening;
  for (const request of socket.sent) {
    if (request.method === "workspace/command" && request.params.method === "questionnaires/pending/read") {
      socket.reply(request, { data: [] });
    }
  }
  assert.ok(warnings.some(message => message.includes("source read unavailable")));
});

test("a resolved existing thread starts its observation while catalogue metadata remains pending", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  data.projects[0]!.locations[0]!.project = null;
  data.catalogues[0]!.phase = "pending";
  socket.observation(projects, { kind: "projects", phase: "stale", failure: null, data });
  const threadId = WorkbenchThreadIdSchema.parse(crypto.randomUUID());
  const route = createLogicalExistingThreadRoute(logicalId,
    { kind: "provider", harness: "codex", threadId }, null);
  assert.equal((await client.controls.applyRoute(route)).pending, true);
  const owner = await socket.request("workspace/observe", 0, request => request.params.query.kind === "threadOwner");
  socket.observation(owner, { kind: "threadOwner", phase: "current", failure: null, data: {
    phase: "current", identity: { threadId, projectId: project.id, harness: "codex" },
    location, logicalProjectId: logicalId,
  } });
  const opening = client.controls.applyRoute(route);
  const read = await socket.request("workspace/observe", 0, request => request.params.query.kind === "thread");
  assert.deepEqual(read.params.query, { kind: "thread", threadId });
  await client.controls.applyRoute(createHomeRoute());
  socket.observation(read, { kind: "thread", phase: "failed", failure: "source read unavailable",
    data: null, owner: { phase: "unavailable", failure: "source read unavailable" } });
  await opening;
  assert.equal(client.navigation.getSnapshot().route.view, "home");
  for (const request of socket.sent) {
    if (request.method === "workspace/command" && request.params.method === "questionnaires/pending/read") {
      socket.reply(request, { data: [] });
    }
  }
  assert.ok(warnings.some(message => message.includes("source read unavailable")));
});

test("a thread viewed from another project keeps demand for its owning project rows", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  const ownerLogicalId = LogicalProjectIdSchema.parse(crypto.randomUUID());
  const ownerLocation = { daemonId: blockedId, projectId: ProjectIdSchema.parse("owner-folder") };
  data.projects.push({
    id: ownerLogicalId, label: "owner", matchKey: "local://owner",
    locations: [{ target: ownerLocation, daemonId: blockedId, hostname: "remote",
      name: "owner", rootPath: "/owner", project: null }],
  });
  socket.observation(projects, { kind: "projects", phase: "stale", failure: null, data });
  const threadId = WorkbenchThreadIdSchema.parse(crypto.randomUUID());
  const route = createLogicalExistingThreadRoute(logicalId,
    { kind: "provider", harness: "codex", threadId }, null);
  assert.equal((await client.controls.applyRoute(route)).pending, true);
  const owner = await socket.request("workspace/observe", 0, request => request.params.query.kind === "threadOwner");
  const ownerRowOffset = socket.sent.length;
  socket.observation(owner, { kind: "threadOwner", phase: "current", failure: null, data: {
    phase: "current", identity: { threadId, projectId: ownerLocation.projectId, harness: "codex" },
    location: ownerLocation, logicalProjectId: ownerLogicalId,
  } });
  const opening = client.controls.applyRoute(route);
  const rows = await socket.request("workspace/observe", ownerRowOffset, request =>
    request.params.query.kind === "projectThreads"
      && request.params.query.projects?.length === 2);
  assert.equal(rows.params.query.kind, "projectThreads");
  if (rows.params.query.kind !== "projectThreads") throw new Error("Expected owner row observation.");
  assert.deepEqual(rows.params.query.projects, [
    { kind: "logical", projectId: logicalId },
    { kind: "logical", projectId: ownerLogicalId },
  ]);
  const read = await socket.request("workspace/observe", ownerRowOffset, request => request.params.query.kind === "thread");
  await client.controls.applyRoute(createHomeRoute());
  socket.observation(read, { kind: "thread", phase: "failed", failure: "source read unavailable",
    data: null, owner: { phase: "unavailable", failure: "source read unavailable" } });
  await opening;
  for (const request of socket.sent) {
    if (request.method === "workspace/command" && request.params.method === "questionnaires/pending/read") {
      socket.reply(request, { data: [] });
    }
  }
  assert.ok(warnings.some(message => message.includes("source read unavailable")));
});

test("source-scoped renderers never reuse another daemon's provider model cache", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const data = facts(true);
  const remoteLocation = { daemonId: blockedId, projectId: project.id };
  data.projects[0]!.locations.push({ target: remoteLocation, daemonId: blockedId, hostname: "remote",
    name: project.name, rootPath: "C:/remote", project: { ...project, rootPath: "C:/remote" } });
  socket.observation(query, { kind: "projects", phase: "current", failure: null, data });
  client.controls.createThreadDraftAt(location, "codex");
  const first = client.controls.listModels("codex");
  const a = await socket.request("workspace/command", 0, request => request.params.method === "models/list");
  assert.deepEqual(a.params.scope, { kind: "installation", daemonId });
  socket.reply(a, { data: [] });
  await first;
  const offset = socket.sent.length;
  client.controls.createThreadDraftAt(remoteLocation, "codex");
  const second = client.controls.listModels("codex");
  const b = await socket.request("workspace/command", offset, request => request.params.method === "models/list");
  assert.deepEqual(b.params.scope, { kind: "installation", daemonId: blockedId });
  socket.reply(b, { data: [] });
  await second;
});

async function openRetainedDraft(context: TestContext) {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const client = WorkbenchClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  socket.observation(projects, { kind: "projects", phase: "stale", failure: null, data: facts(true) });
  await client.controls.applyRoute(createLogicalThreadRoute(logicalId, logicalId, location, { kind: "new" }));
  const draft = client.threadRuntime.getSnapshot().currentThread;
  assert.ok(draft?.isDraft);
  const presentation = await socket.request("workspace/observe", 0, request => request.params.query.kind === "presentation");
  socket.observation(presentation, { kind: "presentation", phase: "current", failure: null, data: {
    revision: 1, projects: [{ id: logicalId, matchKey: "local://bak", label: "bak" }],
    daemons: [{ id: daemonId, hostname: "local" }],
    locations: [{ target: location, logicalProjectId: logicalId, identityKey: "local://bak", name: "bak", rootPath: project.rootPath }],
    defaults: [], folders: [], members: [], divergences: [], sourceMappings: [],
    drafts: [{ id: draft.id, logicalProjectId: logicalId, target: location, prompt: "retained draft words",
      selection: { kind: "custom", settings: { agentPath: null, agentSource: null, harness: "codex",
        model: "model", reasoningEffort: null, serviceTier: null, contextWindowTokens: null } },
      updatedAt: 1, revision: 1, phase: "unsent", pinned: false, snoozed: false,
      launchId: null, acceptedThreadId: null, attachments: [] }],
  } });
  return { socket, client, draft };
}

test("reopening a saved draft warms opencode on its original daemon", async context => {
  const { socket, client, draft } = await openRetainedDraft(context);
  const first = await socket.request("workspace/command", 0, request => request.params.method === "models/list"
    && request.params.params?.provider === "opencode");
  socket.reply(first, { data: [] });
  assert.equal((await client.controls.applyRoute(createHomeRoute())).ok, true);
  const projects = await socket.request("workspace/observe", 0, request => request.params.query.kind === "projects");
  const changed = facts(true);
  changed.sources[0]!.generation++;
  socket.observation(projects, { kind: "projects", phase: "current", failure: null, data: changed }, 2);
  const offset = socket.sent.length;
  assert.equal((await client.controls.applyRoute(createLogicalThreadRoute(logicalId, logicalId, location, {
    kind: "draft", draftId: DraftIdSchema.parse(draft.id),
  }))).ok, true);
  const warmed = await socket.request("workspace/command", offset, request => request.params.method === "models/list"
    && request.params.params?.provider === "opencode");
  assert.deepEqual(warmed.params.scope, { kind: "installation", daemonId });
  socket.reply(warmed, { data: [] });
});

test("accepted draft launch settles without a thread read and cannot steal a newer route", async context => {
  const { socket, client, draft } = await openRetainedDraft(context);
  const launched: Array<{ id: string; harness: string }> = [];
  const offset = socket.sent.length;
  const sending = client.controls.sendThreadMessage(draft, [], {
    onThreadLaunched: identity => launched.push(identity),
  });
  const request = await socket.request("workspace/draft/launch", offset);
  await client.controls.applyRoute(createHomeRoute());
  const threadId = crypto.randomUUID();
  socket.reply(request, { threadId });
  assert.equal(await sending, null);
  assert.deepEqual(launched, [{ id: threadId, harness: "codex" }]);
  assert.equal(client.navigation.getSnapshot().route.view, "home");
  assert.equal(socket.sent.slice(offset).some(item => item.method === "workspace/command"
    && (item.params.method === "thread/page/read" || item.params.method === "thread/reconcile")), false);
});

test("a launched draft routes with the identity the launch applied", async context => {
  const { socket, client, draft } = await openRetainedDraft(context);
  const launched: Array<{ id: string; harness: string }> = [];
  const offset = socket.sent.length;
  const sending = client.controls.sendThreadMessage(draft, [], {
    onThreadLaunched: identity => launched.push(identity),
  });
  const request = await socket.request("workspace/draft/launch", offset);
  const threadId = crypto.randomUUID();
  socket.reply(request, { threadId, harness: "opencode" });
  assert.equal(await sending, null);
  assert.deepEqual(launched, [{ id: threadId, harness: "opencode" }]);
});
