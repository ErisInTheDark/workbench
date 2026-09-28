/*
 * Exports: none.
 * Tests: draft folder changes survive new-to-saved promotion without accepting another route intent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, DaemonIdSchema } from "../identity";
import { createHomeRoute, createLogicalThreadRoute, createObservedProjectRoute, createWorkbenchHref, parseWorkbenchRouteFromLocation, isSameDraftRouteIntent } from "./workbench-route";

test("folder choice remains current through draft promotion, not unrelated navigation", () => {
  const project = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const otherProject = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981002");
  const draftId = DraftIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const otherDraftId = DraftIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const location = {
    daemonId: DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029"),
    projectId: ProjectIdSchema.parse("workbench"),
  };
  const before = createLogicalThreadRoute(null, project, location, { kind: "new" });
  const promoted = createLogicalThreadRoute(null, project, null, { kind: "draft", draftId });
  assert.equal(isSameDraftRouteIntent(before, before, draftId), true);
  assert.equal(isSameDraftRouteIntent(before,
    createLogicalThreadRoute(null, project, location, { kind: "new" }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before, promoted, draftId), true);
  assert.equal(isSameDraftRouteIntent(before,
    createLogicalThreadRoute(null, project, null, { kind: "draft", draftId: otherDraftId }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before,
    createLogicalThreadRoute(null, otherProject, null, { kind: "draft", draftId }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before, createHomeRoute(), draftId), false);
});

test("unregistered folder routes round-trip their real source without inventing a logical identity", () => {
  const location = {
    daemonId: DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029"),
    projectId: ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a"),
  };
  const project = createObservedProjectRoute(location);
  for (const route of [project, { ...project, view: "file" as const, filePath: "folder with spaces/note.md" },
    { ...project, view: "thread" as const, threadId: "", threadTarget: { kind: "new" as const } }]) {
    const restored = parseWorkbenchRouteFromLocation(createWorkbenchHref(route));
    assert.equal(restored.view, route.view);
    assert.deepEqual(restored.logical?.location, location);
    assert.equal(restored.logical?.projectId, null);
    assert.equal(restored.filePath, route.filePath);
    assert.deepEqual(restored.threadTarget, route.threadTarget);
  }
});
