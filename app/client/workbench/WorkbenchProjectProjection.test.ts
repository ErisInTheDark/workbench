/*
 * No production exports. Protect one display identity, qualified locations, and remote-label collisions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { projectLogicalProjects, projectLogicalSummaries } from "./WorkbenchProjectProjection";

const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
const concrete = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
const remoteId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
const collisionId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
const localId = LogicalProjectIdSchema.parse("b12f7e1e-81b6-4c30-bdc0-f83475981003");

function catalog(rootPath: string): WorkbenchProjectOption {
  return { id: concrete, kind: "git", name: "repo", relativePath: "repo", rootPath,
    lastCommitTimeMs: null, roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath }] };
}

test("remote identity has one row, collisions show hosts, and unavailable locations keep their own labels", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [
      { id: remoteId, matchKey: "remote://example.test/team/repo", label: "example.test/team/repo" },
      { id: collisionId, matchKey: "remote://other.test/team/repo", label: "other.test/team/repo" },
      { id: localId, matchKey: "local://C:/other/.git", label: "C:/other" },
    ],
    locations: [
      { target: { daemonId: first, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo" },
      { target: { daemonId: second, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "/home/repo" },
      { target: { daemonId: second, projectId: ProjectIdSchema.parse("other") }, logicalProjectId: collisionId,
        identityKey: "remote://other.test/team/repo", name: "repo", rootPath: "/home/other" },
    ],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map([[first, [catalog("C:/repo")]]]));
  assert.equal(projects.length, 3);
  assert.deepEqual(projects.slice(0, 2).map(project => project.label), [
    "example.test/team/repo", "other.test/team/repo",
  ]);
  assert.equal(projects[2]?.label, "C:/other");
  assert.deepEqual(projects[0]?.locations.map(location => [
    location.hostname, location.rootPath, location.project !== null,
  ]), [["desktop", "C:/repo", true], ["laptop", "/home/repo", false]]);
  assert.equal(projects[0]?.locations[1]?.target.daemonId, second);
  const source = (threadId: string, working: number) => ({
    projects: [{
      projectId: concrete, revision: 1, lastThreadUpdateAt: working,
      counts: { completed: 0, needsAttention: 0, needsAttentionActive: 0,
        proposedCommit: 0, stopped: 0, working },
      pinnedThreads: [],
      unsettledThreads: [{
        activityAt: working, identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse(threadId) },
        status: "working" as const, title: threadId,
      }],
    }],
  });
  const summaries = projectLogicalSummaries(projects, new Map([
    [first, source("desktop-thread", 1)],
    [second, source("laptop-thread", 2)],
  ]));
  assert.equal(summaries.get(remoteId)?.counts.working, 3);
  assert.deepEqual(summaries.get(remoteId)?.unsettledThreads.map(item => [
    item.location.daemonId, item.entry.identity.threadId,
  ]), [[second, "laptop-thread"], [first, "desktop-thread"]]);
});
