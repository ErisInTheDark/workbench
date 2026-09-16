/*
 * Exports:
 * - WorkbenchWorkspaceSelection: current route, drag, and responsive layout inputs.
 * - WorkbenchWorkspaceSnapshot: render layout, route projection, and draft cache.
 * - WorkbenchWorkspaceControllerOptions: navigation and draft creation ports.
 * - default WorkbenchWorkspaceController: own workspace focus, drops, resize, close, minimise, zoom, and draft cache.
 */

import type { ThreadPayload, WorkbenchHarness } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchMainLayout, {
  type WorkbenchDropPlacement,
  type WorkbenchMainLayout as WorkbenchMainLayoutState,
  type WorkbenchPanelTarget,
} from "workbench-shared/workbench/layout/workbench-layout";
import {
  createWorkbenchMosaicSplit,
  createWorkbenchMosaicTarget,
  type WorkbenchMosaicNode,
} from "workbench-shared/workbench/navigation/workbench-mosaic-route";
import type { WorkbenchDragPayload } from "./workbench-drag";
import {
  applyWorkbenchMosaicDrop,
  applyWorkbenchMosaicResize,
  closeWorkbenchMosaicTarget,
  createWorkbenchMainLayoutFromMosaic,
  moveWorkbenchMosaicTarget,
  updateWorkbenchMosaicPanelOptions,
  type WorkbenchMosaicLayoutProjection,
} from "./workbench-mosaic-layout";

type PanelDropPayload = Extract<
  WorkbenchDragPayload,
  { readonly type: "new-thread" | "panel-target" | "thread-row" }
>;

export interface WorkbenchWorkspaceSelection {
  isMobile: boolean;
  isPanelTargetDragActive: boolean;
  mosaicNode: WorkbenchMosaicNode | null;
  routeTarget: WorkbenchPanelTarget;
  showMosaic: boolean;
}

export interface WorkbenchWorkspaceSnapshot {
  draftThreadsById: Readonly<Record<string, ThreadPayload | undefined>>;
  layout: WorkbenchMainLayoutState;
  renderLayout: WorkbenchMainLayoutState | null;
  routeProjection: WorkbenchMosaicLayoutProjection | null;
  selection: WorkbenchWorkspaceSelection;
}

export interface WorkbenchWorkspaceControllerOptions {
  createDraft: (harness: WorkbenchHarness) => ThreadPayload;
  navigateMosaic: (node: WorkbenchMosaicNode, options?: { replace?: boolean }) => void;
  navigatePanel: (target: WorkbenchPanelTarget) => void;
  navigateProject: () => void;
}

function getPanelTargetMosaicNode(target: WorkbenchPanelTarget): WorkbenchMosaicNode | null {
  return target.kind === "file" || target.kind === "thread"
    ? createWorkbenchMosaicTarget(target)
    : null;
}

function createInitialMosaicNode(
  currentTarget: WorkbenchPanelTarget,
  droppedTarget: WorkbenchPanelTarget,
  placement: WorkbenchDropPlacement,
) {
  const currentNode = getPanelTargetMosaicNode(currentTarget);
  const droppedNode = getPanelTargetMosaicNode(droppedTarget);
  if (!droppedNode) return currentNode;
  if (!currentNode) return createWorkbenchMosaicSplit([droppedNode]);
  const children = placement === "left" || placement === "top"
    ? [droppedNode, currentNode]
    : [currentNode, droppedNode];
  return placement === "top" || placement === "bottom"
    ? createWorkbenchMosaicSplit([createWorkbenchMosaicSplit(children)])
    : createWorkbenchMosaicSplit(children);
}

const EMPTY_SELECTION: WorkbenchWorkspaceSelection = {
  isMobile: false,
  isPanelTargetDragActive: false,
  mosaicNode: null,
  routeTarget: { kind: "empty" },
  showMosaic: false,
};

export default class WorkbenchWorkspaceController {
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkbenchWorkspaceSnapshot = {
    draftThreadsById: {},
    layout: WorkbenchMainLayout.fromTarget({ kind: "empty" }),
    renderLayout: null,
    routeProjection: null,
    selection: EMPTY_SELECTION,
  };

  constructor(private options: WorkbenchWorkspaceControllerOptions) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setOptions(options: WorkbenchWorkspaceControllerOptions) {
    this.options = options;
  }

  select(selection: WorkbenchWorkspaceSelection) {
    const routeProjection = selection.showMosaic && selection.mosaicNode
      ? createWorkbenchMainLayoutFromMosaic(selection.mosaicNode)
      : null;
    const layout = selection.showMosaic
      ? this.snapshot.layout
      : WorkbenchMainLayout.replaceFocusedPanel(this.snapshot.layout, selection.routeTarget);
    const temporaryDropLayout = !selection.isMobile
      && !selection.showMosaic
      && selection.isPanelTargetDragActive
      ? WorkbenchMainLayout.fromTarget(selection.routeTarget)
      : null;
    this.publish({
      ...this.snapshot,
      layout,
      renderLayout: routeProjection?.layout ?? temporaryDropLayout,
      routeProjection,
      selection,
    });
  }

  updateLayout(layout: WorkbenchMainLayoutState) {
    this.publish({ ...this.snapshot, layout });
    this.navigateFocusedPanel(layout);
  }

  focusPanel(panelId: string) {
    const layout = WorkbenchMainLayout.focusPanel(this.snapshot.layout, panelId);
    this.publish({ ...this.snapshot, layout });
    this.navigateFocusedPanel(layout);
  }

  dropPanel(
    drop: { panelId: string; placement: WorkbenchDropPlacement },
    payload: PanelDropPayload,
  ) {
    let target: WorkbenchPanelTarget = payload.type === "new-thread"
      ? { kind: "empty" }
      : payload.target;
    if (payload.type === "new-thread") {
      const draft = this.options.createDraft(payload.harness);
      this.publish({
        ...this.snapshot,
        draftThreadsById: {
          ...this.snapshot.draftThreadsById,
          [draft.id]: draft,
        },
      });
      target = {
        kind: "thread",
        target: {
          kind: "provider",
          threadId: ThreadReferenceSchema.parse(draft.id),
        },
      };
    }

    const { mosaicNode, routeTarget, showMosaic } = this.snapshot.selection;
    const projection = this.snapshot.routeProjection;
    if (showMosaic && mosaicNode && projection) {
      const panelPath = projection.panelPathsById[drop.panelId];
      if (!panelPath) return;
      const dropPanel = WorkbenchMainLayout.findPanel(projection.layout, drop.panelId);
      if (
        payload.type === "panel-target"
        && payload.sourcePanelId
        && dropPanel
        && (dropPanel.target.kind === "file" || dropPanel.target.kind === "thread")
      ) {
        this.options.navigateMosaic(
          moveWorkbenchMosaicTarget(mosaicNode, dropPanel.target, drop.placement, target),
        );
        return;
      }
      this.options.navigateMosaic(
        applyWorkbenchMosaicDrop(mosaicNode, panelPath, drop.placement, target),
      );
      return;
    }

    const node = createInitialMosaicNode(routeTarget, target, drop.placement);
    if (node) this.options.navigateMosaic(node);
  }

  updatePanelOptions(panelId: string, options: { minimized?: boolean; zoomDelta?: number }) {
    const { mosaicNode, showMosaic } = this.snapshot.selection;
    const projection = this.snapshot.routeProjection;
    if (!showMosaic || !mosaicNode || !projection) return;
    const panelPath = projection.panelPathsById[panelId];
    if (!panelPath) return;
    this.options.navigateMosaic(
      updateWorkbenchMosaicPanelOptions(mosaicNode, panelPath, options),
      { replace: true },
    );
  }

  resizeSplit(splitId: string, firstPercent: number) {
    const { mosaicNode, showMosaic } = this.snapshot.selection;
    const projection = this.snapshot.routeProjection;
    if (!showMosaic || !mosaicNode || !projection) return;
    const resizeGroup = projection.resizeGroupsById[splitId];
    if (!resizeGroup) return;
    this.options.navigateMosaic(
      applyWorkbenchMosaicResize(mosaicNode, resizeGroup, firstPercent),
      { replace: true },
    );
  }

  closePanel(target: WorkbenchPanelTarget) {
    const { mosaicNode, showMosaic } = this.snapshot.selection;
    if (!showMosaic || !mosaicNode) return;
    const next = closeWorkbenchMosaicTarget(mosaicNode, target);
    if (next) this.options.navigateMosaic(next);
    else this.options.navigateProject();
  }

  closeFile(filePath: string) {
    let layout = this.snapshot.layout;
    for (const panel of WorkbenchMainLayout.panels(layout)) {
      if (panel.target.kind === "file" && panel.target.filePath === filePath) {
        layout = WorkbenchMainLayout.closePanel(layout, panel.id);
      }
    }
    this.publish({ ...this.snapshot, layout });
    const { mosaicNode, showMosaic } = this.snapshot.selection;
    if (!showMosaic || !mosaicNode) return;
    const next = closeWorkbenchMosaicTarget(mosaicNode, { filePath, kind: "file" });
    if (next) this.options.navigateMosaic(next);
    else this.options.navigateProject();
  }

  removeDraftThreads(...threadIds: string[]) {
    const removed = new Set(threadIds);
    const draftThreadsById = Object.fromEntries(
      Object.entries(this.snapshot.draftThreadsById)
        .filter(([threadId]) => !removed.has(threadId)),
    );
    this.publish({ ...this.snapshot, draftThreadsById });
  }

  dispose() {
    this.listeners.clear();
  }

  private navigateFocusedPanel(layout: WorkbenchMainLayoutState) {
    const panel = WorkbenchMainLayout.findPanel(layout, layout.focusedPanelId);
    if (panel) this.options.navigatePanel(panel.target);
  }

  private publish(snapshot: WorkbenchWorkspaceSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
