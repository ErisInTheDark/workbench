/*
 * Exports: none.
 * Tests: missing new-thread defaults inherit only the newest eligible folder selection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection, WorkbenchComposerSettings } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchPresentationClient from "./WorkbenchPresentationClient";
import { createComposerProfileTargetPersistence } from "./composer-profile-api";

test("new folders use the latest same-daemon project default without replacing their own", async () => {
  const daemonId = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const peerId = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2030");
  const logicalId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const otherLogicalId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981002");
  const target = (projectId: string, id = daemonId) => ({ daemonId: id, projectId: ProjectIdSchema.parse(projectId) });
  const settings = (model: string): WorkbenchComposerSettings => ({
    agentPath: null, agentSource: null, harness: "codex", model,
    reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
  });
  const selection = (model: string): WorkbenchComposerProfileTargetSelection =>
    ({ kind: "custom", settings: settings(model) });
  const locations = [
    { target: target("destination", peerId), logicalProjectId: otherLogicalId },
    { target: target("destination"), logicalProjectId: logicalId },
    { target: target("older"), logicalProjectId: logicalId },
    { target: target("newer"), logicalProjectId: logicalId },
    { target: target("different-project"), logicalProjectId: otherLogicalId },
    { target: target("peer", peerId), logicalProjectId: logicalId },
  ].map((item) => ({ ...item, identityKey: "remote://example.test/repo", name: item.target.projectId, rootPath: `C:/${item.target.projectId}` }));
  const snapshot: PresentationSnapshot = {
    revision: 20, daemons: [], projects: [], locations,
    defaults: [
      { target: target("older"), revision: 3, selection: selection("older") },
      { target: target("newer"), revision: 6, selection: selection("newer") },
      { target: target("different-project"), revision: 9, selection: selection("wrong-project") },
      { target: target("peer", peerId), revision: 10, selection: selection("wrong-daemon") },
    ],
    drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const presentation = new WorkbenchPresentationClient({ fetcher: async () => Response.json(snapshot) });
  await presentation.refresh();
  let own: WorkbenchComposerProfileTargetSelection | null = null;
  let profiles: WorkbenchComposerProfile[] = [];
  const daemon = new WorkbenchDaemonClient({
    request: async <TResponse>(method: string) => (method === "profiles/target/read"
      ? { selection: own } : { profiles }) as TResponse,
  });
  const persistence = createComposerProfileTargetPersistence(daemon, async () => undefined, presentation, daemonId);
  const slot = { kind: "new-thread" as const, projectId: ProjectIdSchema.parse("destination") };
  assert.deepEqual(await persistence.read(slot), selection("newer"));
  own = selection("own");
  assert.deepEqual(await persistence.read(slot), own);
  own = null;
  const scopedSettings: WorkbenchComposerSettings = {
    ...settings("newer"), agentPath: "C:/source/.agents/agents/helper.md", agentSource: "project",
  };
  snapshot.defaults[1]!.selection = { kind: "profile", profileId: "scoped", settings: scopedSettings };
  profiles = [{
    ...scopedSettings, id: "scoped", name: "scoped", scope: { kind: "project", projectId: target("newer").projectId },
    createdAt: 1, updatedAt: 1,
  }];
  await presentation.refresh();
  assert.deepEqual(await persistence.read(slot), { kind: "custom", settings: settings("newer") },
    "a source-folder profile and its project agent cannot stay linked in another folder");
  snapshot.defaults[1]!.selection = { kind: "profile", profileId: "global", settings: settings("newer") };
  profiles = [{
    ...settings("newer"), id: "global", name: "global", scope: { kind: "global" },
    createdAt: 1, updatedAt: 1,
  }];
  await presentation.refresh();
  assert.deepEqual(await persistence.read(slot), snapshot.defaults[1]!.selection,
    "a global profile remains linked across folders on its daemon");
  const ownScoped = { kind: "profile" as const, profileId: "own-scoped", settings: scopedSettings };
  snapshot.defaults.push({ target: target("destination"), revision: 1, selection: ownScoped });
  await presentation.refresh();
  assert.deepEqual(await persistence.read(slot), ownScoped,
    "an exact folder's app default retains its own project-scoped profile");
  presentation.dispose();
});
