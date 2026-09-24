/*
 * Exports:
 * - No production exports; Node tests protect workspace projection, focus, drop, resize, close, minimise, zoom, and draft state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload } from "workbench-shared/types";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createWorkbenchMosaicSplit, createWorkbenchMosaicTarget, type WorkbenchMosaicNode } from "workbench-shared/workbench/navigation/workbench-mosaic-route";
import WorkbenchWorkspaceController from "./WorkbenchWorkspaceController.ts";

const draftId = DraftIdSchema.parse("4148c9ad-75b2-4a22-9732-6cb8bb82f414");
function draft(): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [],
    createdAt: 1, cwd: "", harness: "codex",
    id: draftId, isDraft: true, model: null, name: null, path: null,
    preview: "", reasoningEffort: null, serviceTier: null, source: "codex", status: "idle",
    tokenUsage: null, turnHistory: [], turns: [], updatedAt: 1,
  };
}

test("route selection projects mosaic layout and routes resize, zoom, and close intents", () => {
  const navigations: unknown[] = [];
  const mosaic = createWorkbenchMosaicSplit([
    createWorkbenchMosaicTarget({ filePath: "a.ts", kind: "file" }),
    createWorkbenchMosaicTarget({ filePath: "b.ts", kind: "file" }),
  ]);
  const controller = new WorkbenchWorkspaceController({
    createDraft: () => draft(),
    navigateMosaic: (node, options) => navigations.push({ node, options }),
    navigatePanel: () => undefined,
    navigateProject: () => navigations.push("project"),
  });
  controller.select({
    isMobile: false,
    isPanelTargetDragActive: false,
    mosaicNode: mosaic,
    routeTarget: { kind: "empty" },
    showMosaic: true,
  });
  const projection = controller.getSnapshot().routeProjection!;
  const splitId = Object.keys(projection.resizeGroupsById)[0]!;
  const panelId = Object.keys(projection.panelPathsById)[0]!;

  controller.resizeSplit(splitId, 70);
  controller.updatePanelOptions(panelId, { minimized: true, zoomDelta: 0.2 });
  controller.closePanel({ filePath: "a.ts", kind: "file" });

  assert.equal(navigations.length, 3);
  assert.deepEqual((navigations[0] as { options: unknown }).options, { replace: true });
  assert.deepEqual((navigations[1] as { options: unknown }).options, { replace: true });
});

test("new-thread drops cache the draft and navigate one initial mosaic", () => {
  const navigations: WorkbenchMosaicNode[] = [];
  const controller = new WorkbenchWorkspaceController({
    createDraft: () => draft(),
    navigateMosaic: node => { navigations.push(node); },
    navigatePanel: () => undefined,
    navigateProject: () => undefined,
  });
  controller.select({
    isMobile: false,
    isPanelTargetDragActive: true,
    mosaicNode: null,
    routeTarget: { filePath: "a.ts", kind: "file" },
    showMosaic: false,
  });
  const panelId = controller.getSnapshot().renderLayout!.focusedPanelId;

  controller.dropPanel({ panelId, placement: "right" }, {
    harness: "codex",
    type: "new-thread",
  });

  assert.equal(controller.getSnapshot().draftThreadsById[draftId]?.id, draftId);
  assert.equal(navigations.length, 1);
  const navigated = navigations[0];
  assert.equal(navigated?.type, "split");
  if (navigated?.type === "split") {
    assert.deepEqual(navigated.children.flatMap(child => child.type === "target"
      && child.target.kind === "thread" ? [child.target.target] : []),
    [{ kind: "draft", draftId }]);
  }
});

test("equal file paths on separate daemons keep distinct panel owners", () => {
  const logicalProjectId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const projectId = ProjectIdSchema.parse("same");
  const node = createWorkbenchMosaicSplit([first, second].map(daemonId =>
    createWorkbenchMosaicTarget({ kind: "file", filePath: "src/a.ts",
      source: { logicalProjectId, location: { daemonId, projectId } } })));
  const controller = new WorkbenchWorkspaceController({
    createDraft: () => draft(), navigateMosaic: () => undefined,
    navigatePanel: () => undefined, navigateProject: () => undefined,
  });
  controller.select({
    isMobile: false, isPanelTargetDragActive: false, mosaicNode: node,
    routeTarget: { kind: "empty" }, showMosaic: true,
  });
  const panelIds = Object.keys(controller.getSnapshot().routeProjection!.panelPathsById);
  assert.equal(panelIds.length, 2);
  assert.notEqual(panelIds[0], panelIds[1]);
  assert.deepEqual(panelIds.map(id => controller.mosaicTargetForPanel(id)?.source?.location?.daemonId),
    [first, second]);
});
