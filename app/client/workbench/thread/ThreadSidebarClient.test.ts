/*
 * No production exports. Tests protect subscriptions, project-qualified draft queues and leave-safe flushing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadSidebarClient from "./ThreadSidebarClient.ts";
import type { WorkbenchPinnedThreadLayoutSnapshot, WorkbenchProjectThreadSummary, WorkbenchThreadDraft, WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  DraftId: {
    "00000000-0000-4000-8000-000000000001": fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  },
  ProjectId: {
    "beta": fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
    "foreign": fixtureIdentitySchemas.ProjectIdSchema.parse("foreign"),
    "other": fixtureIdentitySchemas.ProjectIdSchema.parse("other"),
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "newer": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("newer"),
    "newer-turn": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("newer-turn"),
    "older-turn": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("older-turn"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "old-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("old-turn"),
  },
};

const draft = (prompt: string, clientUpdatedAt: number): WorkbenchThreadDraft => ({
  attachments: [], clientUpdatedAt, composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt: 1,
  draftId: fixtureIdentityValues.DraftId["00000000-0000-4000-8000-000000000001"],
  profileId: null, projectId: fixtureIdentityValues.ProjectId["project"], prompt, updatedAt: clientUpdatedAt,
});
const snapshot = (revision: number): WorkbenchThreadSidebarSnapshot => ({ entries: [], error: null, freshness: "fresh", projectId: fixtureIdentityValues.ProjectId["project"], revision });
const pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot = { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" };
const counts = (working = 0) => ({
  completed: 0,
  needsAttention: 0,
  needsAttentionActive: 0,
  proposedCommit: 0,
  stopped: 0,
  working,
});
const projectSummary = (
  projectId: string,
  revision: number,
  working = 0,
): WorkbenchProjectThreadSummary => ({
  counts: counts(working),
  lastThreadUpdateAt: null,
  pinnedThreads: [],
  projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
  revision,
  unsettledThreads: [],
});

test("project open adopts the resolved address for subsequent pushes and observation closure", async () => {
  const canonical = fixtureIdentitySchemas.ProjectIdSchema.parse("remote://example.test/owner/repo");
  const closed: string[] = [];
  const client = new ThreadSidebarClient({
    onChange() {},
    transport: {
      open: async () => ({ ...snapshot(1), projectId: canonical }),
      close: async id => { closed.push(id); },
      deleteDraft: async () => {}, upsertDraft: async () => {},
    },
  });
  assert.equal(await client.open(fixtureIdentityValues.ProjectId.project), true);
  assert.equal(client.getSnapshot()?.projectId, canonical);
  client.accept({ ...snapshot(2), projectId: canonical });
  assert.equal(client.getSnapshot()?.revision, 2);
  await client.close();
  assert.deepEqual(closed, [canonical]);
});

for (const mode of ["project", "global"] as const) {
  test(`${mode} reopen keeps pushes that overtake bootstrap and keeps project state isolated`, async () => {
    const makeSidebar = (revision: number, title: string): WorkbenchThreadSidebarSnapshot => ({
      ...snapshot(revision),
      entries: [{
        entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
        activityAt: 1, title, metadata: { archived: false, pinned: false, snoozed: false },
        lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      }],
    });
    const reopened = Promise.withResolvers<WorkbenchThreadSidebarSnapshot>();
    let opens = 0;
    const read = async () => ++opens === 1 ? makeSidebar(100, "before reconnect") : await reopened.promise;
    const client = new ThreadSidebarClient({
      onChange() {},
      transport: {
        close: async () => {}, deleteDraft: async () => {}, upsertDraft: async () => {},
        open: read,
        openGlobal: async () => {
          const current = await read();
          return {
            homeThreadDisplayOrder: null, pinnedThreadLayout,
            projectSidebars: { projects: opens === 1 ? [current, { ...current, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("retired") }] : [current] },
          };
        },
      },
    });
    if (mode === "global") await client.openGlobal();
    else await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
    const pending = client.reopen();
    const pushed = makeSidebar(2, "pushed after reconnect");
    if (mode === "global") client.acceptProjectThreadSidebar({ updateKind: "projectThreadSidebar", sidebar: pushed });
    else client.accept(pushed);
    client.acceptActivity({ activityAt: 30, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, projectId: fixtureIdentityValues.ProjectId["project"], revision: 3, updateKind: "activity" });
    reopened.resolve(makeSidebar(1, "stale bootstrap"));
    await pending;
    const current = client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("project"))!;
    assert.equal(current.entries[0]!.title, "pushed after reconnect");
    assert.equal(current.entries[0]!.activityAt, 30);
    assert.equal(client.getProjectThreadSidebars().projects[0], current);
    assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("retired")), null);
    if (mode === "project") assert.equal(client.getSnapshot(), current);
    else assert.equal(client.getSnapshot(), null);
    client.acceptActivity({ activityAt: 99, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, projectId: fixtureIdentityValues.ProjectId["foreign"], revision: 99, updateKind: "activity" });
    assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), current);
    assert.equal(client.getProjectThreadSummaries().projects.find((value) => value.projectId === "project")!.unsettledThreads[0]!.title, "pushed after reconnect");
  });
}

test("project summaries bootstrap together, merge by revision, and follow selected optimistic status", async () => {
  const stoppedEntry: WorkbenchThreadSidebarSnapshot["entries"][number] = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Thread",
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => ({
        pinnedThreadLayout,
        projectThreads: {
          projects: [
            projectSummary("project", 0),
            projectSummary("other", 1, 2),
          ],
        },
        sidebar: { ...snapshot(1), entries: [stoppedEntry] },
      }),
      upsertDraft: async () => undefined,
    },
  });

  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  assert.deepEqual(client.getProjectThreadSummaries().projects, [
    {
      counts: { ...counts(), stopped: 1 },
      lastThreadUpdateAt: 1,
      pinnedThreads: [{
        activityAt: 1,
        canCompleteQuestionnaire: false,
        entryKind: "thread",
        identity: stoppedEntry.identity,
        lifecycle: stoppedEntry.lifecycle,
        metadata: { archived: false, pinned: true, snoozed: false },
        previousTitles: [],
        status: "stopped",
        title: "Thread",
      }],
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      revision: 1,
      unsettledThreads: [{
        activityAt: 1,
        identity: stoppedEntry.identity,
        status: "stopped",
        title: "Thread",
      }],
    },
    projectSummary("other", 1, 2),
  ]);
  client.acceptProjectThreadSummary({
    summary: projectSummary("other", 2, 3),
    updateKind: "projectThreadSummary",
  });
  client.acceptProjectThreadSummary({
    summary: projectSummary("other", 1, 9),
    updateKind: "projectThreadSummary",
  });
  assert.deepEqual(client.getProjectThreadSummaries().projects[1], projectSummary("other", 2, 3));

  await client.acceptIntent({ identity: stoppedEntry.identity, title: "Thread", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new-turn") });
  const optimisticSummary = client.getProjectThreadSummaries().projects[0]!;
  assert.deepEqual({
    ...optimisticSummary,
    lastThreadUpdateAt: 0,
    pinnedThreads: optimisticSummary.pinnedThreads.map((thread) => ({ ...thread, activityAt: 0 })),
    unsettledThreads: optimisticSummary.unsettledThreads.map((thread) => ({ ...thread, activityAt: 0 })),
  }, {
    counts: counts(1),
    lastThreadUpdateAt: 0,
    pinnedThreads: [{
      activityAt: 0,
      canCompleteQuestionnaire: false,
      entryKind: "thread",
      identity: stoppedEntry.identity,
      lifecycle: { agent: { agentStatus: "working", turnId: "new-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
      metadata: { archived: false, pinned: true, snoozed: false },
      previousTitles: [],
      status: "working",
      title: "Thread",
    }],
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    revision: 1,
    unsettledThreads: [{
      activityAt: 0,
      identity: stoppedEntry.identity,
      status: "working",
      title: "Thread",
    }],
  });
  assert.equal(optimisticSummary.lastThreadUpdateAt, optimisticSummary.unsettledThreads[0]?.activityAt);
  assert.equal((optimisticSummary.lastThreadUpdateAt ?? 0) > stoppedEntry.activityAt, true);
});

test("a pushed project summary received before open resolves survives the bootstrap response", async () => {
  let resolveOpen!: (result: { pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot; projectThreads: { projects: WorkbenchProjectThreadSummary[] }; sidebar: WorkbenchThreadSidebarSnapshot }) => void;
  const openResult = new Promise<{ pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot; projectThreads: { projects: WorkbenchProjectThreadSummary[] }; sidebar: WorkbenchThreadSidebarSnapshot }>((resolve) => {
    resolveOpen = resolve;
  });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => await openResult,
      upsertDraft: async () => undefined,
    },
  });

  const opening = client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.acceptProjectThreadSummary({ summary: projectSummary("other", 2, 4), updateKind: "projectThreadSummary" });
  resolveOpen?.({
    pinnedThreadLayout,
    projectThreads: { projects: [projectSummary("project", 1), projectSummary("other", 1, 1)] },
    sidebar: snapshot(1),
  });
  await opening;

  assert.deepEqual(client.getProjectThreadSummaries().projects, [
    projectSummary("other", 2, 4),
    projectSummary("project", 1),
  ]);
});

test("a pushed global pinned layout received before open resolves survives an older bootstrap layout", async () => {
  let resolveOpen!: (result: { pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot; projectThreads: { projects: WorkbenchProjectThreadSummary[] }; sidebar: WorkbenchThreadSidebarSnapshot }) => void;
  const openResult = new Promise<{ pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot; projectThreads: { projects: WorkbenchProjectThreadSummary[] }; sidebar: WorkbenchThreadSidebarSnapshot }>((resolve) => {
    resolveOpen = resolve;
  });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => await openResult,
      upsertDraft: async () => undefined,
    },
  });
  const opening = client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  const pushed = { displayOrder: { folders: [{ folderId: fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000031"), section: "pinned" as const, threadKeys: ["project/codex%3Athread"], title: "Global" }] }, revision: 2, updateKind: "pinnedThreadLayout" as const };
  client.acceptPinnedThreadLayout(pushed);
  resolveOpen?.({ pinnedThreadLayout: { displayOrder: {}, revision: 1, updateKind: "pinnedThreadLayout" }, projectThreads: { projects: [] }, sidebar: snapshot(1) });
  await opening;
  assert.deepEqual(client.getPinnedThreadLayout(), pushed);
});

test("optimistic edits keep the newest value through one single-flight flush", async () => {
  const writes: WorkbenchThreadDraft[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { writes.push(value); if (writes.length === 1) await first; },
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.edit(draft(fixtureIdentitySchemas.ProjectIdSchema.parse("first value here"), 2));
  const flushing = client.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.edit(draft("newest value here", 3));
  releaseFirst?.();
  await flushing;
  await client.flush();
  assert.deepEqual(writes.map((value) => value.prompt), ["first value here", "newest value here"]);
});

test("optimistic draft edits preserve pushed pin and snooze metadata", async () => {
  const source = draft("keep priority", 1);
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    entries: [{ activityAt: 1, draft: source, entryKind: "draft", metadata: { archived: false, pinned: true, snoozed: true }, title: "keep priority" }],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.edit(draft(fixtureIdentitySchemas.ProjectIdSchema.parse("keep newer priority"), 2));
  const optimistic = client.getSnapshot()?.entries[0];
  assert.deepEqual(optimistic?.entryKind === "draft" ? optimistic.metadata : null, { archived: false, pinned: true, snoozed: true });
});

test("a profile target flush waits for its draft without flushing another draft", async () => {
  const writes: WorkbenchThreadDraft[] = [];
  let release!: () => void;
  const saving = new Promise<void>((resolve) => { release = resolve; });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { writes.push(value); await saving; },
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  const selected = draft("selected draft", 2);
  const other = { ...draft("other draft", 2), draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000099") };
  client.edit(selected);
  client.edit(other);
  try {
    let flushed = false;
    const flushing = client.flushDraft(selected.projectId, selected.draftId).then(() => { flushed = true; });
    assert.deepEqual(writes.map((value) => value.draftId), [selected.draftId]);
    assert.equal(flushed, false);
    release();
    await flushing;
    assert.equal(flushed, true);
    assert.deepEqual(writes.map((value) => value.draftId), [selected.draftId]);
  } finally {
    release();
    await client.close();
  }
});

test("project-qualified snapshots preserve the route snapshot identity in project mode", async () => {
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => undefined,
    },
  });

  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), client.getSnapshot());
  assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("other")), null);
});

test("folder draft creation is optimistic, carries one placement write, and transfers pinned membership on materialization", async () => {
  const folderId = fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000010");
  const source = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("source") },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false },
    metadata: { archived: false as const, pinned: true, snoozed: false },
    orderAt: 1,
    title: "source",
  };
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    displayOrder: { folders: [{ folderId, section: "pinned", threadKeys: ["codex:source"], title: "Work" }] },
    entries: [source],
  };
  const placements: Array<string | undefined> = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => initial,
      upsertDraft: async (_projectId, _draft, placement) => { placements.push(placement); },
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  const pending = draft("folder draft", 2);
  client.edit(pending, { folderId });
  const optimistic = client.getSnapshot();
  const optimisticDraft = optimistic?.entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(optimisticDraft?.entryKind === "draft" ? optimisticDraft.metadata : null, { archived: false, pinned: true, snoozed: false });
  assert.deepEqual(optimistic?.displayOrder?.folders?.[0]?.threadKeys, [`draft:${pending.draftId}`, "codex:source"]);
  await client.flush();
  assert.deepEqual(placements, [folderId]);
  await client.acceptIntent({ draftId: pending.draftId, identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("materialized") }, title: "Materialized", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
  assert.deepEqual(client.getSnapshot()?.displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized", "codex:source"]);
});

test("newer pushed revisions win and foreign project revisions are ignored", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => snapshot(2), upsertDraft: async () => undefined },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.accept(snapshot(1));
  client.accept({ ...snapshot(3), projectId: fixtureIdentityValues.ProjectId["other"] });
  client.accept(snapshot(3));
  assert.deepEqual(installed.map((value) => value?.revision), [undefined, 2, 3]);
});

test("activity updates preserve turn order until a new turn-start order arrives", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const entry = (threadId: string, activityAt: number, orderAt: number): WorkbenchThreadSidebarSnapshot["entries"][number] => ({
    activityAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    orderAt,
    title: threadId,
  });
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    entries: [entry("newer-turn", 2, 20), entry("older-turn", 1, 10)],
  };
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.acceptActivity({ activityAt: 50, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["older-turn"] }, projectId: fixtureIdentityValues.ProjectId["project"], revision: 2, updateKind: "activity" });
  assert.deepEqual(installed.at(-1)?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["newer-turn", "older-turn"]);
  client.acceptActivity({ activityAt: 60, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["older-turn"] }, orderAt: 30, projectId: fixtureIdentityValues.ProjectId["project"], revision: 3, updateKind: "activity" });
  assert.deepEqual(installed.at(-1)?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["older-turn", "newer-turn"]);
  client.acceptActivity({ activityAt: 70, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["newer-turn"] }, projectId: fixtureIdentityValues.ProjectId["project"], revision: 4, updateKind: "activity" });
  assert.deepEqual(installed.at(-1)?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["older-turn", "newer-turn"]);
});

test("optimistic sidebar updates preserve pushed reload dirt", async () => {
  const reloadDirt = {
    dirtyScopes: [{ description: "Core", destructive: false, scope: "server:core" as const }],
    error: null,
    pendingScopes: [],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => ({ ...snapshot(1), reloadDirt }),
      upsertDraft: async () => undefined,
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.edit(draft(fixtureIdentitySchemas.ProjectIdSchema.parse("preserve reload dirt"), 2));
  assert.deepEqual(client.getSnapshot()?.reloadDirt, reloadDirt);
});

test("activity updates project pinned rows through durable user ordering", async () => {
  const entry = (threadId: string, orderAt: number): WorkbenchThreadSidebarSnapshot["entries"][number] => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    displayOrder: { pinned: { "codex:older": { above: [], below: ["codex:newer"] } } },
    entries: [entry("older", 1), entry("newer", 2)],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.acceptActivity({ activityAt: 5, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["newer"] }, orderAt: 5, projectId: fixtureIdentityValues.ProjectId["project"], revision: 2, updateKind: "activity" });
  assert.deepEqual(client.getSnapshot()?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["older", "newer"]);
});

test("authoritative arrivals refresh complete user-order snapshots before later automatic movement", async () => {
  const entry = (threadId: string, orderAt: number): WorkbenchThreadSidebarSnapshot["entries"][number] => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    displayOrder: { pinned: { "codex:older": { above: [], below: ["codex:newer"] } } },
    entries: [entry("arrival", 3), entry("newer", 2), entry("older", 1)],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });

  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  assert.deepEqual(client.getSnapshot()?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["arrival", "older", "newer"]);
  assert.deepEqual(client.getSnapshot()?.displayOrder?.pinned?.["codex:older"], {
    above: ["codex:arrival"],
    below: ["codex:newer"],
  });

  client.acceptActivity({ activityAt: 5, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["newer"] }, orderAt: 5, projectId: fixtureIdentityValues.ProjectId["project"], revision: 2, updateKind: "activity" });
  assert.deepEqual(client.getSnapshot()?.entries.map((candidate) => candidate.entryKind === "thread" ? candidate.identity.threadId : ""), ["arrival", "older", "newer"]);
});

test("external-store subscribers receive each installed snapshot and can unsubscribe", async () => {
  const initial: WorkbenchThreadSidebarSnapshot = {
    ...snapshot(1),
    entries: [{
      activityAt: 1,
      entryKind: "thread",
      identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "Thread",
    }],
  };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => initial, upsertDraft: async () => undefined },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  let notifications = 0;
  const unsubscribe = client.subscribe(() => { notifications += 1; });

  client.acceptActivity({ activityAt: 50, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, projectId: fixtureIdentityValues.ProjectId["project"], revision: 2, updateKind: "activity" });
  assert.equal(notifications, 1);
  assert.equal(client.getSnapshot()?.revision, 2);
  assert.equal(client.getSnapshot()?.entries[0]?.activityAt, 50);
  assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), client.getSnapshot());
  assert.equal(client.getProjectThreadSidebars().projects[0], client.getSnapshot());

  unsubscribe();
  client.acceptActivity({ activityAt: 60, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, projectId: fixtureIdentityValues.ProjectId["project"], revision: 3, updateKind: "activity" });
  assert.equal(notifications, 1);
  assert.equal(client.getSnapshot()?.revision, 3);
});

test("open reports observation admission while retaining bounded failure state", async () => {
  let shouldFail = true;
  let openAttempts = 0;
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => {
        openAttempts += 1;
        if (shouldFail) throw new Error("Observation unavailable");
        return snapshot(1);
      },
      upsertDraft: async () => undefined,
    },
  });
  assert.equal(await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), false);
  assert.equal(client.getSnapshot()?.freshness, "partial");
  assert.match(client.getSnapshot()?.error ?? "", /Observation unavailable/u);
  shouldFail = false;
  assert.equal(await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), true);
  assert.equal(openAttempts, 2);
  assert.equal(client.getSnapshot()?.error, null);
});

test("materialized draft becomes a working thread before its in-flight save settles", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const source = draft("materialize this", 2);
  let releaseSave!: () => void;
  const save = new Promise<void>((resolve) => { releaseSave = resolve; });
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => ({
        ...snapshot(1),
        entries: [{ activityAt: 2, draft: source, entryKind: "draft", metadata: { archived: false, pinned: true, snoozed: true }, title: "materialize this" }],
      }),
      upsertDraft: async () => { markSaveStarted(); await save; },
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.edit({ ...source, prompt: "edited before materialisation", clientUpdatedAt: 3 });
  const flushing = client.flush();
  await saveStarted;
  const accepting = client.acceptIntent({
    draftId: draft("", 2).draftId,
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("materialized") },
    title: "Materialized thread",
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  });
  const optimisticEntries = installed.at(-1)?.entries ?? [];
  assert.equal(optimisticEntries.some((entry) => entry.entryKind === "draft"), false);
  assert.equal(optimisticEntries.some((entry) => entry.entryKind === "thread" && entry.identity.threadId === "materialized" && entry.lifecycle.kind === "working"), true);
  const materialized = optimisticEntries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "materialized");
  assert.deepEqual(materialized?.entryKind === "thread" ? materialized.metadata : null, { archived: false, pinned: true, snoozed: false });
  assert.equal(materialized?.entryKind === "thread" ? materialized.orderAt : null, materialized?.activityAt);
  let acceptanceSettled = false;
  void accepting.then(() => { acceptanceSettled = true; });
  await Promise.resolve();
  assert.equal(acceptanceSettled, false);
  releaseSave?.();
  await Promise.all([accepting, flushing]);
  assert.equal(acceptanceSettled, true);
});

test("accepted intent immediately revives a stopped thread and a newer snapshot remains authoritative", async () => {
  const installed: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const stoppedEntry: WorkbenchThreadSidebarSnapshot["entries"][number] = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["old-turn"] },
    metadata: { archived: false, pinned: true, snoozed: true },
    orderAt: 1,
    title: "Thread",
  };
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => ({ ...snapshot(1), entries: [stoppedEntry] }), upsertDraft: async () => undefined },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  await client.acceptIntent({ identity: stoppedEntry.identity, title: "Thread", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("new-turn") });
  const optimistic = installed.at(-1)?.entries[0];
  assert.equal(optimistic?.entryKind, "thread");
  if (optimistic?.entryKind === "thread") {
    assert.equal(optimistic.lifecycle.kind, "working");
    assert.equal(optimistic.metadata.pinned, true);
    assert.equal(optimistic.metadata.snoozed, false);
    assert.equal(optimistic.orderAt, optimistic.activityAt);
  }
  client.accept({ ...snapshot(2), entries: [{ ...stoppedEntry, lifecycle: { kind: "completed", reason: "providerInactive", settled: false } }] });
  const authoritative = installed.at(-1)?.entries[0];
  assert.equal(authoritative?.entryKind, "thread");
  if (authoritative?.entryKind === "thread") assert.equal(authoritative.lifecycle.kind, "completed");
});

test("failed navigation flush preserves the route and re-enters the same debounced edit path", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let navigated = false;
  let attempts = 0;
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk busy");
      },
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.edit(draft(fixtureIdentitySchemas.ProjectIdSchema.parse("keep this route here"), 2));
  await assert.rejects(client.guardNavigation(() => { navigated = true; }), /disk busy/u);
  assert.equal(navigated, false);

  context.mock.timers.tick(500);
  assert.equal(attempts, 2);
  await client.flush();
});

test("close flushes the newest draft before releasing project observation", async () => {
  const events: string[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => { events.push("close"); },
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { events.push(`save:${value.prompt}`); },
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  client.edit(draft(fixtureIdentitySchemas.ProjectIdSchema.parse("persist before close"), 2));
  await client.close();
  assert.deepEqual(events, ["save:persist before close", "close"]);
});

test("global observation owns full project sidebars and project-qualified draft queues", async () => {
  const sourceDraft = {
    ...draft("move this", 2),
    profileId: "profile-one",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
  };
  const saved: string[] = [];
  const moved: string[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      closeGlobal: async () => undefined,
      deleteDraft: async () => undefined,
      moveDraft: async (sourceProjectId, destinationProjectId, draftId) => {
        moved.push(`${sourceProjectId}:${destinationProjectId}:${draftId}`);
      },
      open: async () => snapshot(1),
      openGlobal: async () => ({
        homeThreadDisplayOrder: { displayOrder: {}, revision: 1, updateKind: "homeThreadDisplayOrder" },
        pinnedThreadLayout,
        projectSidebars: {
          projects: [
            {
              entries: [{ activityAt: 2, draft: sourceDraft, entryKind: "draft", metadata: { archived: false, pinned: false, snoozed: false }, title: "move this" }],
              error: null,
              freshness: "fresh",
              projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
              revision: 1,
            },
            { entries: [], error: null, freshness: "fresh", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), revision: 1 },
          ],
        },
      }),
      upsertDraft: async (projectId, value) => { saved.push(`${projectId}:${value.prompt}`); },
    },
  });

  assert.equal(await client.openGlobal(), true);
  assert.equal(client.getSnapshot(), null);
  assert.equal(client.getHomeThreadDisplayOrderSupported(), true);
  assert.equal(client.getHomeThreadDisplayOrder().revision, 1);
  assert.deepEqual(client.getProjectThreadSidebars().projects.map(({ projectId }) => projectId), ["alpha", "beta"]);
  assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("alpha")), client.getProjectThreadSidebars().projects[0]);
  assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("beta")), client.getProjectThreadSidebars().projects[1]);
  assert.equal(client.getProjectSnapshot(fixtureIdentitySchemas.ProjectIdSchema.parse("missing")), null);
  client.acceptHomeThreadDisplayOrder({
    displayOrder: { pinned: { "alpha/codex%3Athread": { above: [], below: [] } } },
    revision: 2,
    updateKind: "homeThreadDisplayOrder",
  });
  assert.equal(client.getHomeThreadDisplayOrder().revision, 2);

  client.edit({ ...draft("beta edit", 3), projectId: fixtureIdentityValues.ProjectId["beta"] });
  await client.flush();
  assert.deepEqual(saved, ["beta:beta edit"]);

  await client.moveDraft(fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), sourceDraft.draftId);
  assert.deepEqual(moved, [`alpha:beta:${sourceDraft.draftId}`]);
  const sidebars = client.getProjectThreadSidebars().projects;
  assert.equal(sidebars.find(({ projectId }) => projectId === "alpha")?.entries.some((entry) => entry.entryKind === "draft"), false);
  const movedEntry = sidebars.find(({ projectId }) => projectId === "beta")?.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === sourceDraft.draftId);
  assert.equal(movedEntry?.entryKind === "draft" ? movedEntry.draft.projectId : null, "beta");
  assert.equal(movedEntry?.entryKind === "draft" ? movedEntry.draft.profileId : null, "profile-one");
  assert.equal(client.getDraft(fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), sourceDraft.draftId)?.profileId, "profile-one");
});

test("global observation surfaces transport failure and remains recoverable", async () => {
  let projectOpenCount = 0;
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => {
        projectOpenCount += 1;
        return snapshot(1);
      },
      openGlobal: async () => {
        throw new Error("server core is stale");
      },
      upsertDraft: async () => undefined,
    },
  });

  await assert.rejects(client.openGlobal(), /server core is stale/u);
  assert.deepEqual(client.getProjectThreadSidebars(), { projects: [] });
  assert.equal(await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), true);
  assert.equal(projectOpenCount, 1);
});

for (const destination of ["closed", "other project"] as const) {
  test(`draft edits retain their latest baseline with ${destination} observation`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const writes: WorkbenchThreadDraft[] = [];
    const client = new ThreadSidebarClient({
      onChange: () => undefined,
      transport: {
        close: async () => undefined,
        deleteDraft: async () => undefined,
        open: async (projectId) => ({ ...snapshot(1), projectId }),
        upsertDraft: async (projectId, value) => {
          assert.equal(projectId, value.projectId);
          writes.push(value);
        },
      },
    });
    await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
    const initial = { ...draft("first draft", 2), profileId: "keep-profile" };
    client.edit(initial);
    await client.flushDraft(initial.projectId, initial.draftId);
    if (destination === "closed") await client.close();
    else await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("other"));
    assert.deepEqual(client.getDraft(initial.projectId, initial.draftId), initial);
    const next = { ...client.getDraft(initial.projectId, initial.draftId)!, prompt: "later text", clientUpdatedAt: 3, updatedAt: 3 };
    client.edit(next);
    await client.flushDraft(next.projectId, next.draftId);
    const withImage = { ...client.getDraft(next.projectId, next.draftId)!, attachments: [{ id: "late", url: "image:late" }], clientUpdatedAt: 4, updatedAt: 4 };
    client.edit(withImage);
    await client.flushDraft(withImage.projectId, withImage.draftId);
    assert.deepEqual(writes, [initial, next, withImage]);
    assert.equal(withImage.profileId, "keep-profile");
    assert.equal(client.getSnapshot()?.projectId ?? null, destination === "closed" ? null : "other");
  });
}

test("unobserved draft writes await acknowledgement and propagate save failure without losing input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  let release!: () => void;
  const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => {
        await acknowledgement;
        if (fail) throw new Error("save rejected");
      },
    },
  });
  const input = draft("pinned outside observed project", 2);
  client.edit(input);
  let settled = false;
  const flushing = client.flushDraft(input.projectId, input.draftId).finally(() => { settled = true; });
  const rejected = assert.rejects(flushing, /save rejected/u);
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await rejected;
  assert.deepEqual(client.getDraft(input.projectId, input.draftId), input);
  fail = false;
  await client.flushDraft(input.projectId, input.draftId);
  assert.deepEqual(client.getDraft(input.projectId, input.draftId), input);
});

test("a delayed acknowledgement cannot mark a newer detached draft saved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writes: WorkbenchThreadDraft[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => {
        writes.push(value);
        if (writes.length === 1) await first;
      },
    },
  });
  const initial = draft("first", 2);
  const latest = draft("latest", 3);
  client.edit(initial);
  const flushing = client.flushDraft(initial.projectId, initial.draftId);
  client.edit(latest);
  assert.deepEqual(client.getDraft(initial.projectId, initial.draftId), latest);
  releaseFirst();
  await flushing;
  await client.flushDraft(initial.projectId, initial.draftId);
  assert.deepEqual(writes, [initial, latest]);
});

test("newer observed content replaces a clean draft baseline before detaching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => undefined,
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  const initial = draft("local", 2);
  client.edit(initial);
  await client.flush();
  const newer = draft("updated elsewhere", 3);
  client.accept({ ...snapshot(2), entries: [{
    activityAt: 3, draft: newer, entryKind: "draft",
    metadata: { archived: false, pinned: false, snoozed: false }, title: "updated",
  }] });
  await client.close();
  assert.deepEqual(client.getDraft(initial.projectId, initial.draftId), newer);
});

test("newer observed content received during a save survives its older acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => await acknowledgement,
    },
  });
  await client.open(fixtureIdentitySchemas.ProjectIdSchema.parse("project"));
  const initial = draft("saving locally", 2);
  client.edit(initial);
  const saving = client.flush();
  const newer = draft("newer server content", 3);
  client.accept({ ...snapshot(2), entries: [{
    activityAt: 3, draft: newer, entryKind: "draft",
    metadata: { archived: false, pinned: false, snoozed: false }, title: "updated",
  }] });
  release();
  await saving;
  await client.close();
  assert.deepEqual(client.getDraft(initial.projectId, initial.draftId), newer);
});

for (const retirement of ["delete", "admission"] as const) {
  test(`${retirement} retires the detached draft baseline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = new ThreadSidebarClient({
      onChange: () => undefined,
      transport: {
        close: async () => undefined,
        deleteDraft: async () => undefined,
        open: async () => snapshot(1),
        upsertDraft: async () => undefined,
      },
    });
    const initial = draft("retire me", 2);
    client.edit(initial);
    await client.flush();
    assert.deepEqual(client.getDraft(initial.projectId, initial.draftId), initial);
    if (retirement === "delete") await client.delete(initial.draftId, 3, initial.projectId);
    else await client.acceptIntent({ projectId: initial.projectId, draftId: initial.draftId, identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("sent") }, title: "sent", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
    assert.equal(client.getDraft(initial.projectId, initial.draftId), null);
  });
}
