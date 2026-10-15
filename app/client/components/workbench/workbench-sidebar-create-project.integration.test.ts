/*
 * No exports. Protect new-thread defaults from browsing using real persisted launch receipts and public routes.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../../../../shared/WorkbenchTemporaryDirectory";
import WorkbenchPresentationRepository from "../../../server/state/WorkbenchPresentationRepository";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { createLogicalExistingThreadRoute, createLogicalThreadRoute, withProjectSelection } from "workbench-shared/workbench/navigation/workbench-route";
import { projectLogicalProjects } from "workbench-shared/workbench/project/workbench-project-projection";
import WorkbenchProjectNavigation from "../../workbench/navigation/workbench-project-navigation";
import { resolveSidebarCreateTarget } from "./workbench-sidebar-create-project";

test("persisted creation history survives browsing other selected projects and reopening storage", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-create-default-");
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(temporary.path, "presentation.sqlite3") });
  context.after(async () => { await repository.close(); await temporary.dispose(); });
  await repository.start();
  const daemonId = DaemonIdSchema.parse(crypto.randomUUID());
  const physical = (name: string): WorkbenchProjectOption => ({
    id: ProjectIdSchema.parse(crypto.randomUUID()), kind: "git", name, relativePath: name,
    rootPath: `/${name}`, roots: [], lastCommitTimeMs: null,
  });
  const a = physical("a");
  const b = physical("b");
  const projects = [a, b];
  repository.mutate({
    kind: "registerLocations", daemonId, hostname: "local",
    catalog: { data: projects.map(project => {
      const identityKey = ProjectIdentityKeySchema.parse(`local://${project.rootPath}`);
      return { identityKey, rootIdentityKeys: [identityKey], project };
    }) },
  });
  const logical = projectLogicalProjects(repository.read(), new Map([[daemonId, projects]]));
  const logicalA = logical.find(project => project.locations.some(location => location.target.projectId === a.id))!;
  const logicalB = logical.find(project => project.locations.some(location => location.target.projectId === b.id))!;
  const selectedProjectIds = [logicalA.id, logicalB.id];
  const selection = { kind: "custom" as const, settings: {
    agentPath: null, agentSource: null, harness: "codex" as const, model: "test",
    reasoningEffort: null, serviceTier: null,
  } };
  const save = (project: typeof logicalA) => {
    const id = crypto.randomUUID();
    return repository.mutate({ kind: "putDraft", expectedRevision: null, draft: {
      id, logicalProjectId: project.id, target: project.locations[0]!.target,
      prompt: "create", selection, updatedAt: 1,
    } }).drafts.find(draft => draft.id === id)!;
  };
  const launch = (project: typeof logicalA) => {
    const draft = save(project);
    const launchId = crypto.randomUUID();
    repository.mutate({ kind: "reserveLaunch", draftId: draft.id, expectedRevision: draft.revision, launchId, selection });
    repository.mutate({ kind: "completeLaunch", draftId: draft.id, launchId, threadId: crypto.randomUUID() });
  };
  const navigator = new WorkbenchProjectNavigation(projects, [], logical);
  const assertDefault = (expected: typeof logicalA) => {
    for (const browsed of [logicalA, logicalB, logicalA]) {
      const resolved = resolveSidebarCreateTarget({
        createProjectId: browsed.locations[0]!.target.projectId,
        logicalProject: null,
        logicalProjects: logical,
        presentation: repository.read(),
        projects,
        selectedOwnerProjectId: browsed.id,
        selectedProjectIds,
      });
      assert.equal(resolved?.project.id, expected.id, "browsing cannot replace the last successfully created project");
      assert.deepEqual(resolved.location, expected.locations[0]!.target);
      const current = withProjectSelection(createLogicalExistingThreadRoute(null, {
        kind: "provider", threadId: WorkbenchThreadIdSchema.parse(crypto.randomUUID()),
      }), selectedProjectIds);
      const href = navigator.href(createLogicalThreadRoute(null, resolved.project.id, resolved.location, { kind: "new" }),
        current, "inherit");
      assert.ok(href);
      const route = navigator.readRoute(href);
      assert.deepEqual(route.selectedProjectIds, selectedProjectIds);
      assert.equal(route.logical?.threadOwnerProjectId, expected.id);
    }
  };
  launch(logicalA);
  launch(logicalB);
  save(logicalA);
  assertDefault(logicalB);
  await repository.close();
  await repository.start();
  assertDefault(logicalB);
  launch(logicalA);
  assertDefault(logicalA);
});
