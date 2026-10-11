/* No exports. Protect project selection tiers: server groups win while current, listed facts fill in otherwise. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchLogicalProject, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { resolveProjectSelection, type ProjectSelectionFacts } from "./project-selection";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
function logical(index: number): WorkbenchLogicalProject {
  const target = { daemonId, projectId: ProjectIdSchema.parse(`p${index}`) };
  return {
    id: LogicalProjectIdSchema.parse(`00000000-0000-4000-8000-00000000010${index}`), matchKey: `local://p${index}`, label: `p${index}`,
    locations: [{ target, daemonId, hostname: "local", name: `p${index}`, rootPath: `/p${index}`,
      project: { id: target.projectId, kind: "git", name: `p${index}`, rootPath: `/p${index}`, relativePath: `p${index}`,
        lastCommitTimeMs: null, roots: [] } }],
  };
}
const [first, second] = [logical(1), logical(2)];
function row(project: WorkbenchLogicalProject, archived: boolean): WorkbenchLogicalThreadRow {
  return {
    logicalProjectId: project.id, location: project.locations[0]!.target, hostname: "local", rootPath: "/",
    entry: { entryKind: "thread", title: "t", activityAt: 1,
      identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(`${project.label}-thread`) },
      metadata: { archived, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false } },
  } as WorkbenchLogicalThreadRow;
}
function facts(overrides: Partial<ProjectSelectionFacts>): ProjectSelectionFacts {
  return {
    route: { selectedProjectIds: null, logical: undefined }, logicalProjects: [first, second], physicalProjects: [],
    groups: { phase: "pending", data: null }, logicalSummaries: {}, rows: [], rowsLoading: false,
    sidebars: { projects: [] }, summaries: { projects: [] }, presentationMode: true, browseLocation: null,
    ...overrides,
  };
}

test("current groups decide the default selection over listed rows", () => {
  const selection = resolveProjectSelection(facts({
    groups: { phase: "current", data: { orderedProjectIds: [second.id, first.id], unarchivedProjectIds: [second.id], unsettledProjectIds: [] } },
    rows: [row(first, false)],
  }));
  assert.deepEqual(selection.selectionProjectIds, [second.id]);
  assert.deepEqual(selection.orderedProjectIds, [second.id, first.id]);
  assert.equal(selection.createProjectId, "p2");
});

test("without current groups, unarchived listed rows decide the default selection and a loading list is pending", () => {
  const selection = resolveProjectSelection(facts({ rows: [row(first, false), row(second, true)], rowsLoading: true }));
  assert.deepEqual(selection.selectionProjectIds, [first.id]);
  assert.deepEqual(selection.orderedProjectIds, [first.id, second.id]);
  assert.equal(selection.pending, true);
  assert.equal(resolveProjectSelection(facts({ route: { selectedProjectIds: [second.id], logical: undefined }, rowsLoading: true })).pending, false);
});

test("folder mode selects physical projects from their sidebars when no logical project exists", () => {
  const physical = first.locations[0]!.project as WorkbenchProjectOption;
  const selection = resolveProjectSelection(facts({
    logicalProjects: [], physicalProjects: [physical], presentationMode: false,
    sidebars: { projects: [{ projectId: physical.id, revision: 1, freshness: "fresh", error: null,
      entries: [row(first, false).entry] }] },
  }));
  assert.equal(selection.displayedLogicalProjects, undefined);
  assert.deepEqual(selection.selectionProjectIds, [physical.id]);
  assert.equal(selection.createProjectId, physical.id);
});
