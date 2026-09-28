/* No production exports. Protect partial layout writes and home/project folder ownership. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalThreadRow } from "workbench-shared/types";
import { DaemonIdSchema, FolderIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { getWorkbenchHomeFolderKey, getWorkbenchHomeThreadKey, projectWorkbenchHomeThreadList } from "workbench-shared/workbench/thread/home-thread-display-order";
import { getWorkbenchThreadDisplayKey, projectWorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { projectLogicalHomeDisplayOrder, projectLogicalThreadDisplayOrder } from "workbench-shared/workbench/project/workbench-project-projection";
import { createPresentationLayoutMutation, editPresentationHomeOrder, editPresentationProjectOrder } from "./workbench-presentation-layout";

const project = LogicalProjectIdSchema.parse("10000000-0000-4000-8000-000000000001");
const other = LogicalProjectIdSchema.parse("10000000-0000-4000-8000-000000000002");
const daemonId = DaemonIdSchema.parse("10000000-0000-4000-8000-000000000003");
const folderId = FolderIdSchema.parse("10000000-0000-4000-8000-000000000004");

function row(index: number, logicalProjectId = project): WorkbenchLogicalThreadRow {
  return {
    logicalProjectId, hostname: "source", rootPath: "C:/source",
    location: { daemonId, projectId: ProjectIdSchema.parse(logicalProjectId) },
    entry: {
      entryKind: "thread", identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(
        `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ) }, activityAt: index, title: `thread ${index}`,
      metadata: { archived: false, pinned: true, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    },
  };
}

function snapshot(rows: WorkbenchLogicalThreadRow[]): PresentationSnapshot {
  return {
    revision: 1, daemons: [], projects: [], locations: [], defaults: [], drafts: [], divergences: [], sourceMappings: [],
    folders: [{ id: folderId, scope: "project", logicalProjectId: project, position: 0, title: "folder" }],
    members: rows.map((row, position) => ({
      id: `30000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
      scope: "project", logicalProjectId: row.logicalProjectId,
      folderId: position < 2 && row.logicalProjectId === project ? folderId : null,
      kind: "thread", draftId: null, thread: {
        location: row.location, threadId: row.entry.entryKind === "draft" ? "" : row.entry.identity.threadId,
      }, position,
    })),
  };
}

function install(state: PresentationSnapshot, mutations: ReturnType<typeof createPresentationLayoutMutation>[]) {
  return {
    ...state,
    folders: mutations.reduce((folders, mutation) => [
      ...folders.filter(folder => folder.scope !== mutation.scope || folder.logicalProjectId !== mutation.logicalProjectId),
      ...mutation.folders,
    ], state.folders),
    members: mutations.reduce((members, mutation) => [
      ...members.filter(member => member.scope !== mutation.scope || member.logicalProjectId !== mutation.logicalProjectId),
      ...mutation.members,
    ], state.members),
  };
}

test("editing a partial project preserves hidden members, their folder, and stable identities", () => {
  const rows = [row(1), row(2), row(3)];
  const state = snapshot(rows);
  const visible = [rows[2]!];
  const order = editPresentationProjectOrder(state, project, visible, {
    kind: "move", section: "pinned", sourceKey: getWorkbenchThreadDisplayKey(visible[0]!.entry),
    destinationFolderId: null, beforeKey: null,
  });
  assert.ok(order);
  const mutation = createPresentationLayoutMutation(state, visible, { scope: "project", logicalProjectId: project, order });
  assert.deepEqual(mutation.members, state.members);
  assert.deepEqual(mutation.folders, state.folders);
});

test("moving within a home folder changes its project order without rewriting home order", () => {
  const rows = [row(1), row(2), row(3)];
  const state = snapshot(rows);
  const selections = editPresentationHomeOrder(state, rows, {
    sourceKey: getWorkbenchHomeThreadKey(project, rows[1]!.entry), section: "pinned",
    destinationFolderKey: getWorkbenchHomeFolderKey(project, folderId),
    beforeKey: getWorkbenchHomeThreadKey(project, rows[0]!.entry),
  });
  assert.equal(selections.length, 1);
  assert.equal(selections[0]!.scope, "project");
  const next = install(state, selections.map(selection => createPresentationLayoutMutation(state, rows, selection)));
  const order = projectLogicalThreadDisplayOrder(project, rows, next);
  assert.deepEqual(order.folders?.[0]?.threadKeys, [
    getWorkbenchThreadDisplayKey(rows[1]!.entry), getWorkbenchThreadDisplayKey(rows[0]!.entry),
  ]);
});

test("moving a home folder preserves membership as a block and rejects foreign membership", () => {
  const rows = [row(1), row(2), row(3), row(4, other)];
  const state = snapshot(rows);
  assert.throws(() => editPresentationHomeOrder(state, rows, {
    sourceKey: getWorkbenchHomeThreadKey(other, rows[3]!.entry), section: "pinned",
    destinationFolderKey: getWorkbenchHomeFolderKey(project, folderId), beforeKey: null,
  }), /another project/);
  const selections = editPresentationHomeOrder(state, rows, {
    sourceKey: getWorkbenchHomeFolderKey(project, folderId), section: "pinned",
    destinationFolderKey: null, beforeKey: null,
  });
  const next = install(state, selections.map(selection => createPresentationLayoutMutation(state, rows, selection)));
  const list = projectWorkbenchHomeThreadList({ projects: [project, other].map(projectId => ({
    projectId, entries: rows.filter(row => row.logicalProjectId === projectId).map(row => row.entry),
    displayOrder: projectLogicalThreadDisplayOrder(projectId, rows, next),
  })) }, projectLogicalHomeDisplayOrder(rows, next));
  assert.equal(list.pinnedItems.at(-1)?.itemKind, "folder");
  assert.deepEqual(next.folders, state.folders);
  assert.deepEqual(next.members.filter(member => member.scope === "project"), state.members);
});

test("project folder moves retain the folder and do not require a thread source", () => {
  const rows = [row(1), row(2), row(3)];
  const state = snapshot(rows);
  const order = editPresentationProjectOrder(state, project, rows, {
    kind: "move", section: "pinned",
    sourceKey: `folder:${folderId}` as ReturnType<typeof getWorkbenchThreadDisplayKey>,
    destinationFolderId: null, beforeKey: null,
  });
  assert.ok(order);
  const items = projectWorkbenchThreadDisplaySection(rows.map(row => row.entry), order, "pinned");
  assert.equal(items.at(-1)?.itemKind, "folder");
  assert.equal(order.folders?.[0]?.folderId, folderId);
});
