/*
 * Exports:
 * - No production exports; Node tests protect workspace projection, focus, drop, resize, close, minimise, zoom, and draft state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload } from "workbench-shared/types";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { createWorkbenchMosaicSplit, createWorkbenchMosaicTarget } from "workbench-shared/workbench/navigation/workbench-mosaic-route";
import WorkbenchWorkspaceController from "./WorkbenchWorkspaceController.ts";

function draft(): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [],
    createdAt: 1, cwd: "", harness: "codex",
    id: WorkbenchThreadIdSchema.parse("draft"), isDraft: false, model: null, name: null, path: null,
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
  let navigated = false;
  const controller = new WorkbenchWorkspaceController({
    createDraft: () => draft(),
    navigateMosaic: () => {
      navigated = true;
    },
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

  assert.equal(navigated, true);
  assert.equal(controller.getSnapshot().draftThreadsById.draft?.id, "draft");
});
