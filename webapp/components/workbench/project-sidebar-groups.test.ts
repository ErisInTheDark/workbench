/*
 * No production exports. Tests protect project activity sorting, stable ties, priority promotion, snooze semantics, and progressive recency groups.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchProjectOption } from "../../lib/types";
import type { WorkbenchProjectThreadSummary } from "../../lib/workbench/thread/thread-state";
import { groupSidebarProjects } from "./project-sidebar-groups";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = 200 * DAY_MS;

function project(id: string, ageDays: number | null, kind: WorkbenchProjectOption["kind"] = "git"): WorkbenchProjectOption {
  return {
    id,
    kind,
    lastCommitTimeMs: ageDays === null ? null : NOW_MS - ageDays * DAY_MS,
    name: id,
    relativePath: `team/${id}`,
    rootPath: `C:/projects/team/${id}`,
    roots: [{ id, isPrimary: true, name: id, relativePath: `team/${id}`, rootPath: `C:/projects/team/${id}` }],
  };
}

function summary(
  projectId: string,
  ageDays: number,
  snoozed = false,
): WorkbenchProjectThreadSummary {
  const activityAt = NOW_MS - ageDays * DAY_MS;
  return {
    counts: snoozed ? {
      completed: 0,
      needsAttention: 0,
      needsAttentionActive: 0,
      proposedCommit: 0,
      stopped: 0,
      working: 0,
    } : {
      completed: 0,
      needsAttention: 0,
      needsAttentionActive: 0,
      proposedCommit: 0,
      stopped: 0,
      working: 1,
    },
    lastThreadUpdateAt: activityAt,
    pinnedThreads: [],
    projectId,
    revision: 1,
    unsettledThreads: snoozed ? [] : [{
      activityAt,
      identity: { harness: "codex", threadId: `${projectId}-thread` },
      status: "working",
      title: `${projectId} thread`,
    }],
  };
}

test("sidebar project grouping promotes libraries and unsnoozed unsettled work without headings or folder groups", () => {
  const grouped = groupSidebarProjects([
    project("old-priority", 180),
    project("library", null, "workbench-library"),
    project("recent", 2),
    project("snoozed", 1),
    project("month", 20),
  ], [
    summary("old-priority", 3),
    summary("snoozed", 1, true),
  ], NOW_MS);

  assert.deepEqual(grouped.alwaysVisibleProjects.map(({ project: entry }) => entry.id), ["library", "old-priority"]);
  assert.deepEqual(grouped.timeGroups.map(({ label, projects }) => ({
    label,
    projects: projects.map(({ project: entry }) => entry.id),
  })), [
    { label: "last week", projects: ["snoozed", "recent"] },
    { label: "last month", projects: ["month"] },
  ]);
});

test("thread activity overrides commit activity and catalog order breaks equal-date ties", () => {
  const grouped = groupSidebarProjects([
    project("commit-new", 1),
    project("thread-new", 100),
    project("tie-a", 20),
    project("tie-b", 20),
  ], [
    {
      ...summary("thread-new", 2, true),
      unsettledThreads: [],
    },
  ], NOW_MS);

  assert.deepEqual(grouped.timeGroups.flatMap(({ projects }) => projects.map(({ project: entry }) => entry.id)), [
    "commit-new",
    "thread-new",
    "tie-a",
    "tie-b",
  ]);
});
