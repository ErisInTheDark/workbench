/*
 * No production exports. Tests protect layered sorting, user-order snapshots, one-level folders, section transitions, and malformed-state fallback.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createThreadDisplayFolder,
  getProjectQualifiedThreadDisplayKey,
  moveThreadDisplayLayoutItem,
  parseProjectQualifiedThreadDisplayKey,
  projectThreadDisplayLayoutSection,
  reconcileThreadDisplayLayout,
} from "./thread-display-layout.ts";
import {
  createWorkbenchThreadFolder,
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadDisplaySection,
  moveWorkbenchThreadDisplayItem,
  moveWorkbenchThreadDisplayOrder,
  projectWorkbenchThreadDisplaySection,
  reconcileWorkbenchThreadDisplayOrder,
  replaceWorkbenchThreadFolderMember,
  resolveWorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplayOrder,
} from "./thread-display-order.ts";
import type { WorkbenchThreadLifecycle, WorkbenchThreadSidebarEntry } from "./thread-state.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    "project/a": fixtureIdentitySchemas.ProjectIdSchema.parse("project/a"),
    "project/b": fixtureIdentitySchemas.ProjectIdSchema.parse("project/b"),
  },
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "parent": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"),
  },
};

function thread(
  id: string,
  orderAt: number,
  options: {
    claimed?: boolean;
    lifecycle?: WorkbenchThreadLifecycle;
    pinned?: boolean;
    settled?: boolean;
    snoozed?: boolean;
  } = {},
): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> {
  const lifecycle = options.lifecycle ?? { kind: "completed", reason: "providerInactive", settled: options.settled ?? false };
  return {
    activityAt: orderAt,
    entryKind: "thread",
    ...(options.claimed ? {
      gitArc: {
        checkpointCommit: "a".repeat(40), claimedPaths: [`src/${id}.ts`], intentDescription: "", intentName: id,
        phase: "active", proposals: [], updatedAt: "2026-08-25T00:00:00.000Z",
      },
    } : {}),
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id) },
    lifecycle,
    metadata: { archived: false, pinned: options.pinned ?? false, snoozed: options.snoozed ?? false },
    orderAt,
    title: id,
  };
}

function draft(id: string, createdAt: number, options: { pinned?: boolean; snoozed?: boolean } = {}): Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> {
  return {
    activityAt: createdAt,
    draft: {
      attachments: [], clientUpdatedAt: createdAt, composerSettings: { agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null }, createdAt,
      draftId: fixtureIdentitySchemas.DraftIdSchema.parse(id), profileId: null, projectId: fixtureIdentityValues.ProjectId["project"], prompt: id, updatedAt: createdAt,
    },
    entryKind: "draft",
    metadata: { archived: false, pinned: options.pinned ?? false, snoozed: options.snoozed ?? false },
    title: id,
  };
}

function ids(entries: readonly WorkbenchThreadSidebarEntry[]) {
  return entries.map(getWorkbenchThreadDisplayKey);
}

const attention = (): WorkbenchThreadLifecycle => ({ kind: "needsAttention", reason: "noActiveTurn", settled: false });
const working = (turnId: string): WorkbenchThreadLifecycle => ({ agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId) }, kind: "working", reason: "acceptedIntent", settled: false });

test("archives follow settled layout and snoozed claims stay below working threads", () => {
  const archived = { ...thread("archive", 999), metadata: { archived: true as const, pinned: false as const, snoozed: false as const } };
  const entries = [
    archived,
    thread("settled", 1, { settled: true }),
    thread("purple", 100, { claimed: true, snoozed: true, lifecycle: attention() }),
    thread("working", 1, { lifecycle: working("turn") }),
  ];
  assert.deepEqual(ids(resolveWorkbenchThreadDisplayOrder(entries, {}).entries), [
    "codex:working", "codex:purple", "codex:settled", "codex:archive",
  ]);
  assert.equal(getWorkbenchThreadDisplaySection(archived), null);
});

test("automatic sidebar order applies settlement, priority, claims, lifecycle, and turn time as layers", () => {
  const entries = [
    thread("settled-pinned", 100, { pinned: true, settled: true }),
    thread("snoozed-claim", 100, { claimed: true, pinned: true, snoozed: true }),
    thread("normal-complete", 100),
    thread("normal-stopped", 110, { lifecycle: { kind: "stopped", reason: "userMarkedStopped", settled: false } }),
    thread("normal-working-older", 10, { lifecycle: working("working-older") }),
    thread("normal-working-newer", 20, { lifecycle: working("working-newer") }),
    thread("normal-attention", 1, { lifecycle: attention() }),
    draft("00000000-0000-4000-8000-000000000001", 1),
    thread("normal-claim-complete", 1, { claimed: true }),
    thread("pinned-working", 1, { lifecycle: working("pinned"), pinned: true }),
    thread("pinned-claim-complete", 1, { claimed: true, pinned: true }),
    thread("settled-normal", 200, { settled: true }),
  ];

  assert.deepEqual(ids(resolveWorkbenchThreadDisplayOrder(entries, {}).entries), [
    "codex:pinned-claim-complete",
    "codex:pinned-working",
    "codex:normal-claim-complete",
    "draft:00000000-0000-4000-8000-000000000001",
    "codex:normal-attention",
    "codex:normal-working-newer",
    "codex:normal-working-older",
    "codex:normal-stopped",
    "codex:normal-complete",
    "codex:snoozed-claim",
    "codex:settled-pinned",
    "codex:settled-normal",
  ]);
});

test("a complete user snapshot becomes a total comparator rank and refreshes around automatic arrivals", () => {
  const claimed = thread("claimed", 3, { claimed: true, pinned: true });
  const attentionEntry = thread("attention", 2, { lifecycle: attention(), pinned: true });
  const moved = thread("moved", 1, { pinned: true });
  const natural = resolveWorkbenchThreadDisplayOrder([claimed, attentionEntry, moved], {});
  const order = moveWorkbenchThreadDisplayOrder(natural.entries, natural.displayOrder, "pinned", "codex:moved", "codex:claimed");
  assert.ok(order);

  const arrival = thread("arrival", 4, { claimed: true, lifecycle: attention(), pinned: true });
  const resolved = resolveWorkbenchThreadDisplayOrder([arrival, claimed, attentionEntry, moved], order);
  assert.deepEqual(ids(resolved.entries), ["codex:arrival", "codex:moved", "codex:claimed", "codex:attention"]);
  assert.deepEqual(resolved.displayOrder.pinned?.["codex:moved"], {
    above: ["codex:arrival"],
    below: ["codex:claimed", "codex:attention"],
  });

  const automaticallyMoved = { ...attentionEntry, lifecycle: working("changed"), orderAt: 10 };
  const refreshed = resolveWorkbenchThreadDisplayOrder([arrival, claimed, automaticallyMoved, moved], resolved.displayOrder);
  assert.deepEqual(ids(refreshed.entries), ["codex:arrival", "codex:moved", "codex:claimed", "codex:attention"]);
});

test("project layout keys stay aligned when non-layout rows precede reorderable rows", () => {
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 4,
    createdAt: 4,
    cwd: "C:/project",
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["child"] },
    lifecycle: working("child-turn"),
    name: "child",
    parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"],
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: fixtureIdentityValues.ProjectId["project"],
    title: "child",
    updatedAt: 4,
  };
  const first = thread("first", 3, { snoozed: true });
  const second = thread("second", 2, { snoozed: true });
  const moved = moveWorkbenchThreadDisplayOrder([child, first, second], {}, "snoozed", "codex:second", "codex:first");
  assert.ok(moved);
  const resolved = resolveWorkbenchThreadDisplayOrder([child, first, second], moved);
  assert.deepEqual(
    resolved.entries.filter((entry) => getWorkbenchThreadDisplaySection(entry) === "snoozed").map(getWorkbenchThreadDisplayKey),
    ["codex:second", "codex:first"],
  );
});

test("leaving a reorderable section clears the row and every touching relation", () => {
  const first = thread("first", 2, { pinned: true });
  const second = thread("second", 1, { pinned: true });
  const moved = moveWorkbenchThreadDisplayOrder([first, second], {}, "pinned", "codex:second", "codex:first");
  assert.ok(moved);
  const reconciled = reconcileWorkbenchThreadDisplayOrder([first, thread("second", 1)], moved);
  assert.deepEqual(reconciled, {});
});

test("settlement owns display section before snooze and snooze owns it before pin", () => {
  assert.equal(getWorkbenchThreadDisplaySection(thread("snoozed", 1, { pinned: true, snoozed: true })), "snoozed");
  assert.equal(getWorkbenchThreadDisplaySection(thread("settled", 1, { pinned: true, settled: true, snoozed: true })), "settled");
});

test("folders replace their source at the root and own total child order", () => {
  const first = thread("first", 3, { pinned: true });
  const second = thread("second", 2, { pinned: true });
  const third = thread("third", 1, { pinned: true });
  const folderId = "00000000-0000-4000-8000-000000000010";
  const created = createWorkbenchThreadFolder([first, second, third], {}, folderId, "codex:second", "Work");
  assert.ok(created);
  const filled = moveWorkbenchThreadDisplayItem([first, second, third], created, "pinned", "codex:first", folderId, "codex:second");
  assert.ok(filled);
  const items = projectWorkbenchThreadDisplaySection([first, second, third], filled, "pinned");
  assert.deepEqual(items.map((item) => item.itemKind === "folder" ? item.folder.title : item.entry.title), ["Work", "third"]);
  assert.deepEqual(items[0]?.itemKind === "folder" ? items[0].entries.map((entry) => entry.title) : [], ["first", "second"]);
});

test("moving the last member out prunes its empty folder and positions the thread at the root", () => {
  const first = thread("first", 2, { snoozed: true });
  const second = thread("second", 1, { snoozed: true });
  const folderId = "00000000-0000-4000-8000-000000000011";
  const created = createWorkbenchThreadFolder([first, second], {}, folderId, "codex:first", "Later");
  assert.ok(created);
  const moved = moveWorkbenchThreadDisplayItem([first, second], created, "snoozed", "codex:first", null, "codex:second");
  assert.ok(moved);
  assert.equal(moved.folders, undefined);
  assert.deepEqual(projectWorkbenchThreadDisplaySection([first, second], moved, "snoozed").map((item) => item.itemKind === "thread" ? item.entry.title : item.folder.title), ["first", "second"]);
});

test("reconciliation removes members that leave a folder section and prunes empty folders", () => {
  const snoozed = thread("thread", 1, { snoozed: true });
  const folderId = "00000000-0000-4000-8000-000000000012";
  const created = createWorkbenchThreadFolder([snoozed], {}, folderId, "codex:thread", "Later");
  assert.ok(created);
  const reconciled = reconcileWorkbenchThreadDisplayOrder([thread("thread", 1, { pinned: true })], created);
  assert.deepEqual(reconciled, {});
});

test("drafts can join matching unsettled folders and transfer membership to a pinned provider thread", () => {
  const source = thread("source", 2, { pinned: true });
  const pending = draft("00000000-0000-4000-8000-000000000013", 3, { pinned: true });
  const folderId = "00000000-0000-4000-8000-000000000014";
  const created = createWorkbenchThreadFolder([pending, source], {}, folderId, "codex:source", "Work");
  assert.ok(created);
  const filled = moveWorkbenchThreadDisplayItem([pending, source], created, "pinned", `draft:${pending.draft.draftId}`, folderId, null);
  assert.ok(filled);
  const projected = projectWorkbenchThreadDisplaySection([pending, source], filled, "pinned")[0];
  assert.deepEqual(projected?.itemKind === "folder" ? projected.entries.map(getWorkbenchThreadDisplayKey) : [], ["codex:source", `draft:${pending.draft.draftId}`]);
  const replacement = thread("materialized", 4, { pinned: true, lifecycle: working("turn") });
  const transferred = replaceWorkbenchThreadFolderMember(filled, `draft:${pending.draft.draftId}`, "codex:materialized");
  const reconciled = reconcileWorkbenchThreadDisplayOrder([replacement, source], transferred);
  assert.deepEqual(reconciled.folders?.[0]?.threadKeys, ["codex:source", "codex:materialized"]);
});

test("cyclic persisted relations resolve to natural order and refresh consistently", () => {
  const first = thread("first", 2, { pinned: true });
  const second = thread("second", 1, { pinned: true });
  const cyclic: WorkbenchThreadDisplayOrder = {
    pinned: {
      "codex:first": { above: ["codex:second"], below: [] },
      "codex:second": { above: ["codex:first"], below: [] },
    },
  };
  const resolved = resolveWorkbenchThreadDisplayOrder([first, second], cyclic);
  assert.deepEqual(ids(resolved.entries), ["codex:first", "codex:second"]);
  assert.deepEqual(resolved.displayOrder.pinned, {
    "codex:first": { above: [], below: ["codex:second"] },
    "codex:second": { above: ["codex:first"], below: [] },
  });
});

test("invalid stored ordering safely becomes empty ordering", () => {
  const first = thread("first", 2, { pinned: true });
  const second = thread("second", 1, { pinned: true });
  const resolved = resolveWorkbenchThreadDisplayOrder([first, second], { pinned: "nope" });
  assert.deepEqual(ids(resolved.entries), ["codex:first", "codex:second"]);
  assert.deepEqual(resolved.displayOrder, {});
});

test("global pinned keys keep equal provider identities distinct across projects", () => {
  const left = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project/a"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:thread"));
  const right = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project/b"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:thread"));
  assert.notEqual(left, right);
  assert.deepEqual(parseProjectQualifiedThreadDisplayKey(left), { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project/a"), threadKey: "codex:thread" });
});

test("global pinned folders accept mixed projects without pruning a cold project member", () => {
  const left = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project/a"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:left"));
  const right = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project/b"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:right"));
  const folderId = "00000000-0000-4000-8000-000000000030";
  const entries = [{ key: left, section: "pinned" as const }, { key: right, section: "pinned" as const }];
  const created = createThreadDisplayFolder(entries, {}, folderId, left, "Everywhere", { preserveMissing: true });
  assert.ok(created);
  const filled = moveThreadDisplayLayoutItem(entries, created, "pinned", right, folderId, null, { preserveMissing: true });
  assert.deepEqual(filled?.folders?.[0]?.threadKeys, [left, right]);
  const sparse = reconcileThreadDisplayLayout([entries[0]!], filled, { preserveMissing: true });
  assert.deepEqual(sparse.folders?.[0]?.threadKeys, [left, right]);
  assert.deepEqual(projectThreadDisplayLayoutSection(
    [{ title: "left" }],
    [entries[0]!],
    sparse,
    "pinned",
    { preserveMissing: true },
  )[0], {
    entries: [{ title: "left" }],
    folder: { folderId, section: "pinned", threadKeys: [left, right], title: "Everywhere" },
    itemKind: "folder",
  });
});
