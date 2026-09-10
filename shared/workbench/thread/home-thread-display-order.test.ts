/*
 * No production exports. Tests protect one combined home projection, project-owned folder collapse, qualified identities, and block order moves.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkbenchHomeFolderKey,
  getWorkbenchHomeThreadKey,
  moveWorkbenchHomeThreadDisplayItem,
  projectWorkbenchHomeThreadList,
  resolveWorkbenchHomeThreadSectionKeys,
} from "./home-thread-display-order.ts";
import { getWorkbenchThreadDisplayKey } from "./thread-display-order.ts";
import type { WorkbenchProjectThreadSidebars, WorkbenchThreadSidebarEntry, WorkbenchThreadSidebarSnapshot } from "./thread-state.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "alpha": fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    "beta": fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
  },
};

function thread(
  projectId: string,
  threadId: string,
  activityAt: number,
  options: { pinned?: boolean; snoozed?: boolean } = {},
): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> {
  return {
    activityAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: {
      archived: false,
      pinned: options.pinned ?? false,
      snoozed: options.snoozed ?? false,
    },
    orderAt: activityAt,
    title: `${projectId}:${threadId}`,
  };
}

function sidebar(
  projectId: string,
  entries: WorkbenchThreadSidebarEntry[],
  displayOrder: WorkbenchThreadSidebarSnapshot["displayOrder"] = {},
): WorkbenchThreadSidebarSnapshot {
  return { displayOrder, entries, error: null, freshness: "fresh", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId), revision: 1 };
}

function sidebars(...projects: WorkbenchThreadSidebarSnapshot[]): WorkbenchProjectThreadSidebars {
  return { projects };
}

test("home keeps archives available outside settled manual layout", () => {
  const archived = { ...thread("project", "archive", 99), metadata: { archived: true as const, pinned: false as const, snoozed: false as const } };
  const settled = { ...thread("project", "settled", 1), lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: true } };
  const list = projectWorkbenchHomeThreadList(sidebars(sidebar("project", [archived, settled])), {});
  assert.deepEqual(list.archivedEntries.map(({ entry }) => entry.title), ["project:archive"]);
  assert.equal(list.settledItems.length, 1);
  assert.equal(list.mainEntries.length, 0);
});

test("home projects one list and collapses each project folder at its first globally ordered member", () => {
  const alphaOlder = thread("alpha", "older", 20, { pinned: true });
  const alphaNewer = thread("alpha", "newer", 30, { pinned: true });
  const betaPinned = thread("beta", "pinned", 40, { pinned: true });
  const alphaMain = thread("alpha", "main", 50);
  const folderId = fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000101");
  const list = projectWorkbenchHomeThreadList(sidebars(
    sidebar("alpha", [alphaOlder, alphaNewer, alphaMain], {
      folders: [{
        folderId,
        section: "pinned",
        threadKeys: [getWorkbenchThreadDisplayKey(alphaOlder), getWorkbenchThreadDisplayKey(alphaNewer)],
        title: "Alpha folder",
      }],
    }),
    sidebar("beta", [betaPinned]),
  ), {});

  assert.deepEqual(list.mainEntries.map(({ projectId, entry }) => [projectId, entry.title]), [["alpha", "alpha:main"]]);
  assert.equal(list.pinnedItems.length, 2);
  assert.deepEqual(list.pinnedItems.map((item) => item.itemKind === "folder"
    ? {
      entries: item.entries.map(({ entry }) => entry.title),
      folder: item.folder.title,
      projectId: item.projectId,
    }
    : {
      projectId: item.entry.projectId,
      thread: item.entry.entry.title,
    }), [
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), thread: "beta:pinned" },
    { entries: ["alpha:older", "alpha:newer"], folder: "Alpha folder", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha") },
  ]);
  assert.equal(getWorkbenchHomeFolderKey(fixtureIdentityValues.ProjectId["alpha"], folderId).startsWith("alpha/"), true);
});

test("home order moves a project folder as one qualified thread block without changing membership", () => {
  const alphaA = thread("alpha", "same-id", 10, { snoozed: true });
  const alphaB = thread("alpha", "second", 20, { snoozed: true });
  const betaA = thread("beta", "same-id", 30, { snoozed: true });
  const entries = [
    { key: getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], betaA), section: "snoozed" as const },
    { key: getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaB), section: "snoozed" as const },
    { key: getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaA), section: "snoozed" as const },
  ];
  const moved = moveWorkbenchHomeThreadDisplayItem(
    entries,
    {},
    "snoozed",
    [getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaA), getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaB)],
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], betaA),
  );
  assert.ok(moved);
  assert.deepEqual(resolveWorkbenchHomeThreadSectionKeys(entries, moved, "snoozed"), [
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaA),
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaB),
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], betaA),
  ]);
  assert.notEqual(getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alphaA), getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], betaA));
  assert.equal("folders" in moved, false);
});

test("home manual priority order remains separate from project display order", () => {
  const alpha = thread("alpha", "alpha", 10, { pinned: true });
  const beta = thread("beta", "beta", 20, { pinned: true });
  const projects = sidebars(sidebar("alpha", [alpha]), sidebar("beta", [beta]));
  const natural = projectWorkbenchHomeThreadList(projects, {});
  const entries = [
    { key: getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], beta), section: "pinned" as const },
    { key: getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alpha), section: "pinned" as const },
  ];
  const displayOrder = moveWorkbenchHomeThreadDisplayItem(
    entries,
    natural.displayOrder,
    "pinned",
    [getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alpha)],
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], beta),
  );
  const overridden = projectWorkbenchHomeThreadList(projects, displayOrder);

  assert.deepEqual(natural.pinnedItems.map((item) => item.threadKeys[0]), [
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], beta),
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alpha),
  ]);
  assert.deepEqual(overridden.pinnedItems.map((item) => item.threadKeys[0]), [
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["alpha"], alpha),
    getWorkbenchHomeThreadKey(fixtureIdentityValues.ProjectId["beta"], beta),
  ]);
  assert.deepEqual(projects.projects.map(({ displayOrder }) => displayOrder), [{}, {}]);
});
