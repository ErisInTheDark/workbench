/*
 * No exports. Protect workspace observation shapes from resending whole members or thread rows when one field changes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyObservationDelta, diffObservationValue } from "./observation-patch";
import {
  DaemonWorkspaceObservationSchema, DaemonWorkspaceQuerySchema, WorkspaceObservationSchema, WorkspaceQuerySchema,
  daemonObservationShape, workspaceObservationShape, type WorkspaceObservation,
} from "./workspace-observation";

const threadId = "00000001-0000-4000-8000-000000000000";
const gitArc = (claimedPaths: string[], proposals: Array<{ proposalId: string; status: "proposed" }>) => ({
  phase: "active", checkpointCommit: "a".repeat(40), claimedPaths, stashedPaths: [], proposals,
});
const subscriptionId = "00000000-0000-4000-8000-000000000001";
const entry = (activityAt: number, extra: object = {}) => ({
  entryKind: "thread", title: "thread", activityAt, waitingOnThreads: [], ...extra,
  identity: { harness: "codex", threadId },
  metadata: { archived: false, pinned: false, snoozed: false },
  lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
});
const location = { daemonId: "00000000-0000-4000-8000-0000000000da", projectId: "project" };

test("file observation demand names its own folder without project selection", () => {
  assert.deepEqual(WorkspaceQuerySchema.parse({ kind: "projectFile", location, path: "notes.md" }),
    { kind: "projectFile", location, path: "notes.md" });
  assert.deepEqual(DaemonWorkspaceQuerySchema.parse({ kind: "projectFile", projectId: location.projectId, path: "notes.md" }),
    { kind: "projectFile", projectId: location.projectId, path: "notes.md" });
});

test("file deltas retain unchanged HEAD content at both observation hops", () => {
  const first = {
    kind: "projectFile" as const, subscriptionId, generation: 1, revision: 1, phase: "current", failure: null,
    data: { projectId: "project", path: "notes.md", content: "before", headContent: "unchanged HEAD",
      mtimeMs: 1, updatedAt: new Date(1).toISOString(), changeSummary: null },
  };
  const next = { ...first, data: { ...first.data, content: "after", mtimeMs: 2 } };
  for (const shape of [daemonObservationShape("projectFile"), workspaceObservationShape("projectFile")]) {
    const delta = diffObservationValue(first, next, shape)!;
    assert.ok(!JSON.stringify(delta).includes(first.data.headContent));
    assert.deepEqual(applyObservationDelta(first, delta, shape), next);
  }
});

test("peer commit updates preserve unchanged rows at both observation hops", () => {
  for (const kind of ["branchCommits", "gitPeerCommits"] as const) {
    const shape = kind === "branchCommits" ? daemonObservationShape(kind) : workspaceObservationShape(kind);
    const first = { kind, subscriptionId, generation: 1, revision: 1, phase: "current", failure: null,
      data: { branch: "main", head: "a".repeat(40), tip: "b".repeat(40), total: 1,
        commits: [{ commit: "b".repeat(40), subject: "unchanged" }] } };
    const next = { ...first, revision: 2, data: { ...first.data, tip: "c".repeat(40), total: 2,
      commits: [{ commit: "c".repeat(40), subject: "new" }, ...first.data.commits] } };
    const delta = diffObservationValue(first, next, shape)!;
    assert.ok(!JSON.stringify(delta).includes("unchanged"));
    assert.deepEqual(applyObservationDelta(first, delta, shape), next);
  }
});
const member = (activityAt: number) => ({
  key: `observed/${location.daemonId}/${location.projectId}/codex:${threadId}`, homeKey: null, logicalProjectId: null,
  location, hostname: "host", rootPath: "C:/project", title: "thread", activityAt,
  ref: { kind: "thread", identity: { harness: "codex", threadId } },
});
const membership = (activityAt: number) => WorkspaceObservationSchema.parse({
  kind: "projectThreads", subscriptionId, generation: 1, revision: 1, phase: "current", failure: null,
  data: {
    members: [member(activityAt), { ...member(1), key: "other", ref: { kind: "draft", draftId: "draft" } }],
    placement: { main: [], archived: [], pinned: [], snoozed: [], settled: [] },
    folders: { pinned: [], projects: {} }, projects: [],
  },
}) as Extract<WorkspaceObservation, { kind: "projectThreads" }>;
const summaries = (arc?: ReturnType<typeof gitArc>) => WorkspaceObservationSchema.parse({
  kind: "threadSummaries", subscriptionId, generation: 1, revision: 1, phase: "current", failure: null,
  data: { [threadId]: { location, logicalProjectId: null, summary: { facts: {}, row: entry(1, arc ? { gitArc: arc } : {}) } } },
}) as Extract<WorkspaceObservation, { kind: "threadSummaries" }>;

test("a member's activity tick ships that member's changed field, not the membership", () => {
  const shape = workspaceObservationShape("projectThreads");
  const delta = diffObservationValue(membership(10_000), membership(20_000), shape)!;
  const updates = delta.objects?.data?.collections?.members?.update ?? [];
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.delta, { set: { activityAt: 20_000 } });
  assert.deepEqual(applyObservationDelta(membership(10_000), delta, shape), membership(20_000));
});

test("a git arc change on a summarised thread ships only the changed claims and proposals, and still validates the row", () => {
  const shape = workspaceObservationShape("threadSummaries");
  const before = summaries(gitArc(["a.ts", "b.ts"], [{ proposalId: "p", status: "proposed" }]));
  const after = summaries(gitArc(["a.ts", "c.ts"], [{ proposalId: "p", status: "proposed" }, { proposalId: "q", status: "proposed" }]));
  const delta = diffObservationValue(before, after, shape)!;
  const shipped = JSON.stringify(delta);
  assert.ok(!shipped.includes("\"title\"") && !shipped.includes("\"a.ts\""), "unchanged row fields and claims stay home");
  assert.deepEqual(applyObservationDelta(before, delta, shape), after);
});

test("a draft edit ships that draft's changed fields, not the whole presentation", () => {
  const shape = workspaceObservationShape("presentation");
  const draft = (id: string, prompt: string, revision: number) => ({
    id, logicalProjectId: "00000000-0000-4000-8000-0000000000aa", target: location, prompt,
    selection: { kind: "custom", settings: { harness: "codex", model: "", agentPath: null,
      agentSource: null, reasoningEffort: null, serviceTier: null } }, updatedAt: revision, revision, phase: "unsent",
    pinned: false, snoozed: false, launchId: null, acceptedThreadId: null, attachments: [],
  });
  const presentation = (prompt: string, revision: number) => WorkspaceObservationSchema.parse({
    kind: "presentation", subscriptionId, generation: 1, revision: 1, phase: "current", failure: null,
    data: { revision, daemons: [{ id: location.daemonId, hostname: "host" }], projects: [], locations: [], defaults: [],
      drafts: [draft("00000000-0000-4000-8000-0000000000d1", prompt, revision),
        draft("00000000-0000-4000-8000-0000000000d2", "an untouched draft", 1)],
      folders: [], members: [], divergences: [], sourceMappings: [] },
  });
  const before = presentation("typing", 2);
  const after = presentation("typing more", 3);
  const delta = diffObservationValue(before, after, shape)!;
  assert.ok(!JSON.stringify(delta).includes("an untouched draft"), JSON.stringify(delta).slice(0, 300));
  assert.deepEqual(applyObservationDelta(before, delta, shape), after);
});

test("each resolved startup project drops one pending id instead of resending the pending list", () => {
  const placement = (resolved: number) => {
    const ids = ["p1", "p2", "p3"];
    return DaemonWorkspaceObservationSchema.parse({
      kind: "projectPlacement", subscriptionId, generation: 1, revision: 1, phase: "pending", failure: null, failures: [],
      projects: ids.slice(0, resolved).map(projectId => ({ projectId, hasUnarchivedWork: false })),
      pendingProjectIds: ids.slice(resolved),
    });
  };
  const shape = daemonObservationShape("projectPlacement");
  const delta = diffObservationValue(placement(1), placement(2), shape)!;
  assert.deepEqual(delta.collections?.pendingProjectIds, { remove: ["p2"] });
  assert.equal(delta.set, undefined);
  assert.deepEqual(applyObservationDelta(placement(1), delta, shape), placement(2));
});

test("sidebar row protocol v2 is explicit while legacy rows conform compacting to false", () => {
  assert.deepEqual(WorkspaceQuerySchema.parse({
    kind: "projectThreads", projects: null, sidebarRowVersion: 2,
  }), { kind: "projectThreads", projects: null, sidebarRowVersion: 2 });
  assert.deepEqual(DaemonWorkspaceQuerySchema.parse({
    kind: "projectThreads", projectIds: ["project"], sidebarRowVersion: 2,
  }), { kind: "projectThreads", projectIds: ["project"], sidebarRowVersion: 2 });
  const row = summaries().data[threadId]?.summary.row;
  assert.equal(row?.entryKind === "thread" ? row.compacting ?? false : null, false);
});

test("project tree updates ship changed counts and touched nodes, not the whole tree", () => {
  const tree = (extra: boolean) => WorkspaceObservationSchema.parse({
    kind: "projectTree", subscriptionId: "00000000-0000-4000-8000-000000000001", generation: 1, revision: 1, sourceGeneration: 1,
    phase: "current", failure: null,
    data: { projectId: "project", revision: extra ? 2 : 1, updateKind: "project", snapshot: {
      projectId: "project", root: "C:/project", rootPath: "C:/project", roots: [], workbenchStorageRootPath: "C:/project/.workbench",
      changes: extra ? { "src/a.ts": { additions: 2, deletions: 0 } } : { "src/a.ts": { additions: 1, deletions: 0 }, "old.ts": { additions: 0, deletions: 3 } },
      tree: [
        { type: "file", name: "old.ts", path: "old.ts" },
        { type: "directory", name: "src", path: "src", children: [
          { type: "file", name: "a.ts", path: "src/a.ts" },
          ...extra ? [{ type: "file", name: "b.ts", path: "src/b.ts" }] : [],
        ] },
      ],
    } },
  }) as Extract<WorkspaceObservation, { kind: "projectTree" }>;
  const shape = workspaceObservationShape("projectTree");
  const delta = diffObservationValue(tree(false), tree(true), shape)!;
  assert.deepEqual(delta.objects?.data?.objects?.snapshot, {
    objects: {
      changes: { set: { "src/a.ts": { additions: 2, deletions: 0 } }, unset: ["old.ts"] },
    },
    collections: {
      tree: { update: [{ key: "src", delta: { collections: { children: { add: [{ key: "src/b.ts", item: { type: "file", name: "b.ts", path: "src/b.ts" } }] } } } }] },
    },
  });
  const before = tree(false);
  const applied = applyObservationDelta(before, delta, shape);
  assert.deepEqual(applied, tree(true));
  assert.equal(applied.data?.snapshot.tree[0], before.data?.snapshot.tree[0], "untouched nodes keep their identity");
});
