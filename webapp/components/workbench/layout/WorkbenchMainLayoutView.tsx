/*
 * Exports:
 * - default WorkbenchMainLayoutView: render a recursive desktop split layout with panel drop targets. Keywords: workbench, split pane, drag drop.
 * - Local helpers: resolve panel placement and render the isolated live drop preview. Keywords: mosaic, pointer, preview, geometry.
 */
"use client";

import { useSyncExternalStore, type CSSProperties, type PointerEvent, type ReactNode } from "react";

import { WORKBENCH_MAIN_PANEL_DROP_TARGET_ID, type WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import WorkbenchMainLayout, {
  type WorkbenchDropPlacement,
  type WorkbenchMainLayout as WorkbenchMainLayoutState,
  type WorkbenchMainLayoutDrop,
  type WorkbenchMainLayoutNode,
  type WorkbenchPanelTarget,
} from "../../../lib/workbench/layout/workbench-layout";
import DropTarget from "../drag/DropTarget";
import { useWorkbenchDragController } from "../drag/workbench-drag-context";

type WorkbenchMosaicPanelMetadata = Extract<WorkbenchMainLayoutNode, { readonly type: "leaf" }>["mosaicPanel"];
type WorkbenchPanelDropPayload = Extract<WorkbenchDragPayload, { readonly type: "new-thread" | "panel-target" | "thread-row" }>;
type WorkbenchDropPreview = WorkbenchMainLayoutDrop & {
  readonly rect: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  };
};

interface WorkbenchMainLayoutViewProps {
  layout: WorkbenchMainLayoutState;
  onFocusPanel: (panelId: string) => void;
  onLayoutChange: (layout: WorkbenchMainLayoutState) => void;
  onPanelDrop?: (drop: WorkbenchMainLayoutDrop, payload: WorkbenchPanelDropPayload) => void;
  onPointerDrop: () => void;
  onSplitResize?: (splitId: string, firstPercent: number) => void;
  renderPanel: (panel: {
    isFocused: boolean;
    mosaicPanel?: WorkbenchMosaicPanelMetadata;
    panelId: string;
    target: WorkbenchPanelTarget;
  }) => ReactNode;
}

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function isPanelScrollOwnedByContent(target: WorkbenchPanelTarget) {
  return target.kind === "thread";
}

function getDropPlacementFromPoint(panel: HTMLElement, clientX: number, clientY: number): WorkbenchDropPlacement {
  const rect = panel.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const horizontalRatio = rect.width ? x / rect.width : 0.5;
  const verticalRatio = rect.height ? y / rect.height : 0.5;
  if (horizontalRatio >= 0.36 && horizontalRatio <= 0.64 && verticalRatio >= 0.36 && verticalRatio <= 0.64) {
    return "center";
  }

  const edgeDistances: Array<{ placement: WorkbenchDropPlacement; distance: number }> = [
    { distance: x, placement: "left" },
    { distance: rect.width - x, placement: "right" },
    { distance: y, placement: "top" },
    { distance: rect.height - y, placement: "bottom" },
  ];

  edgeDistances.sort((left, right) => left.distance - right.distance);
  return edgeDistances[0]?.placement ?? "right";
}

function getDropPreviewStyle(preview: WorkbenchDropPreview): CSSProperties {
  const inset = 8;
  const gutter = 4;
  const halfWidth = preview.rect.width / 2;
  const halfHeight = preview.rect.height / 2;
  const horizontalHalfWidth = Math.max(0, halfWidth - inset - gutter / 2);
  const verticalHalfHeight = Math.max(0, halfHeight - inset - gutter / 2);
  if (preview.placement === "center") {
    return {
      height: Math.max(0, preview.rect.height - inset * 2),
      left: preview.rect.left + inset,
      top: preview.rect.top + inset,
      width: Math.max(0, preview.rect.width - inset * 2),
    };
  }

  if (preview.placement === "left") {
    return {
      height: Math.max(0, preview.rect.height - inset * 2),
      left: preview.rect.left + inset,
      top: preview.rect.top + inset,
      width: horizontalHalfWidth,
    };
  }
  if (preview.placement === "right") {
    return {
      height: Math.max(0, preview.rect.height - inset * 2),
      left: preview.rect.left + halfWidth + gutter / 2,
      top: preview.rect.top + inset,
      width: horizontalHalfWidth,
    };
  }
  if (preview.placement === "top") {
    return {
      height: verticalHalfHeight,
      left: preview.rect.left + inset,
      top: preview.rect.top + inset,
      width: Math.max(0, preview.rect.width - inset * 2),
    };
  }

  return {
    height: verticalHalfHeight,
    left: preview.rect.left + inset,
    top: preview.rect.top + halfHeight + gutter / 2,
    width: Math.max(0, preview.rect.width - inset * 2),
  };
}

function getDropFromPoint(
  clientX: number,
  clientY: number,
  payload: WorkbenchPanelDropPayload,
): WorkbenchDropPreview | null {
  if (typeof document === "undefined") return null;
  const element = document.elementFromPoint(clientX, clientY);
  const panel = element?.closest<HTMLElement>("[data-panel-id]");
  const panelId = panel?.dataset.panelId;
  if (payload.type === "panel-target" && payload.sourcePanelId && panelId === payload.sourcePanelId) return null;
  const rect = panel?.getBoundingClientRect();
  return panel && panelId
    ? {
      panelId,
      placement: getDropPlacementFromPoint(panel, clientX, clientY),
      rect: {
        height: rect?.height ?? 0,
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width ?? 0,
      },
    }
    : null;
}

function WorkbenchDropPreviewOverlay() {
  const controller = useWorkbenchDragController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const preview = snapshot.active
    && snapshot.payload
    && (snapshot.payload.type === "panel-target" || snapshot.payload.type === "thread-row" || snapshot.payload.type === "new-thread")
    ? getDropFromPoint(snapshot.x, snapshot.y, snapshot.payload)
    : null;
  return preview ? (
    <div
      aria-hidden="true"
      className={joinClasses(
        "pointer-events-none fixed z-[80] rounded-[0.75rem] border shadow-[0_0_0_1px_var(--accent)]",
        preview.placement === "center"
          ? "border-[#d0ad12]/70 bg-[#d0ad12]/25"
          : "border-accent/55 bg-accent-soft/55",
      )}
      style={getDropPreviewStyle(preview)}
    />
  ) : null;
}

export default function WorkbenchMainLayoutView ({
  layout,
  onFocusPanel,
  onLayoutChange,
  onPanelDrop,
  onPointerDrop,
  onSplitResize,
  renderPanel,
}: WorkbenchMainLayoutViewProps) {
  function applyPanelTargetDrop(drop: WorkbenchMainLayoutDrop, payload: WorkbenchPanelDropPayload) {
    if (onPanelDrop) {
      onPanelDrop(drop, payload);
      return;
    }

    if (payload.type === "panel-target" || payload.type === "thread-row") {
      onLayoutChange(WorkbenchMainLayout.applyDrop(layout, drop, payload.target));
    }
  }

  function beginSplitResize(event: PointerEvent<HTMLDivElement>, node: Extract<WorkbenchMainLayoutNode, { type: "split" }>) {
    if (!onSplitResize || event.button !== 0) {
      return;
    }

    event.preventDefault();
    const splitElement = event.currentTarget.parentElement;
    if (!splitElement) {
      return;
    }

    const handlePointerMove = (pointerEvent: globalThis.PointerEvent) => {
      const rect = splitElement.getBoundingClientRect();
      const rawPercent = node.direction === "horizontal"
        ? ((pointerEvent.clientX - rect.left) / Math.max(rect.width, 1)) * 100
        : ((pointerEvent.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
      onSplitResize(node.id, Math.min(95, Math.max(5, rawPercent)));
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  }

  function renderNode(node: WorkbenchMainLayoutNode): ReactNode {
    if (node.type === "split") {
      const firstTrack = node.firstMinimized
        ? node.direction === "horizontal" ? "2.75rem" : "3.25rem"
        : `minmax(0, ${node.firstFr ?? 1}fr)`;
      const secondTrack = node.secondMinimized
        ? node.direction === "horizontal" ? "2.75rem" : "3.25rem"
        : `minmax(0, ${node.secondFr ?? 1}fr)`;
      return (
        <div
          key={node.id}
          className={joinClasses(
            "grid h-full min-h-0 min-w-0 flex-1 overflow-hidden",
          )}
          style={node.direction === "horizontal"
            ? { gridTemplateColumns: `${firstTrack} 0.35rem ${secondTrack}` }
            : { gridTemplateRows: `${firstTrack} 0.35rem ${secondTrack}` }}
        >
          {renderNode(node.first)}
          <div
            aria-hidden="true"
            className={joinClasses(
              "bg-[color-mix(in_srgb,var(--text)_10%,transparent)] transition hover:bg-accent",
              onSplitResize ? "cursor-col-resize" : null,
              node.direction === "vertical" && "cursor-row-resize",
            )}
            onPointerDown={(event) => {
              beginSplitResize(event, node);
            }}
          />
          {renderNode(node.second)}
        </div>
      );
    }

    return (
      <DropTarget
        className="h-full min-h-0 min-w-0 flex-1"
        dropTargetId={WORKBENCH_MAIN_PANEL_DROP_TARGET_ID}
        enabled={(payload) => (payload.type === "panel-target" || payload.type === "thread-row" || payload.type === "new-thread")
          && !(payload.type === "panel-target" && payload.sourcePanelId === node.id)}
        key={node.id}
        onDrop={(payload, point) => {
          if (payload.type !== "panel-target" && payload.type !== "thread-row" && payload.type !== "new-thread") return;
          const drop = getDropFromPoint(point.x, point.y, payload);
          if (drop) applyPanelTargetDrop(drop, payload);
          onPointerDrop();
        }}
      >
        <section
        className={joinClasses(
          "explorer-scrollbar relative h-full min-h-0 min-w-0 overflow-x-hidden border border-[color-mix(in_srgb,var(--text)_10%,transparent)]",
          isPanelScrollOwnedByContent(node.target) ? "overflow-hidden" : "overflow-y-auto",
        )}
        data-panel-id={node.id}
        onClick={() => {
          onFocusPanel(node.id);
        }}
      >
        {renderPanel({
          isFocused: layout.focusedPanelId === node.id,
          mosaicPanel: node.mosaicPanel,
          panelId: node.id,
          target: node.target,
        })}
        </section>
      </DropTarget>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      {renderNode(layout.root)}
      <WorkbenchDropPreviewOverlay />
    </div>
  );
}
