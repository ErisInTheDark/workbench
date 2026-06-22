/*
 * Exports:
 * - WorkbenchPanelTarget: serializable target rendered by a workbench main panel. Keywords: workbench, layout, panel target.
 * - WorkbenchMainLayoutNode/WorkbenchMainLayout: recursive split tree for the desktop main area. Keywords: workbench, split, tree.
 * - WorkbenchDropPlacement/WorkbenchMainLayoutDrop: typed drop intent for panel replacement or directional splitting. Keywords: drag, drop, split.
 * - default WorkbenchMainLayout: namespace of layout creation, traversal, mutation, normalization, and persistence-safe helpers. Keywords: layout model, split operations.
 */

import type { WorkbenchSettingsScope } from "../navigation/workbench-route";

export type WorkbenchPanelTarget =
  | {
    readonly kind: "empty";
  }
  | {
    readonly kind: "collaborationCollaborator";
  }
  | {
    readonly kind: "collaborationScratchpad";
  }
  | {
    readonly filePath: string;
    readonly kind: "file";
  }
  | {
    readonly kind: "settings";
    readonly scope: WorkbenchSettingsScope;
  }
  | {
    readonly kind: "thread";
    readonly threadId: string;
  };

export type WorkbenchMainLayoutNode =
  | {
    readonly id: string;
    readonly mosaicPanel?: {
      readonly minimized?: boolean;
      readonly parentDirection?: "horizontal" | "vertical";
      readonly zoomDelta?: number;
    };
    readonly target: WorkbenchPanelTarget;
    readonly type: "leaf";
  }
  | {
    readonly direction: "horizontal" | "vertical";
    readonly first: WorkbenchMainLayoutNode;
    readonly firstFr?: number;
    readonly firstMinimized?: boolean;
    readonly id: string;
    readonly second: WorkbenchMainLayoutNode;
    readonly secondFr?: number;
    readonly secondMinimized?: boolean;
    readonly type: "split";
  };

export interface WorkbenchMainLayout {
  readonly focusedPanelId: string;
  readonly root: WorkbenchMainLayoutNode;
}

export type WorkbenchDropPlacement = "center" | "left" | "right" | "top" | "bottom";

export interface WorkbenchMainLayoutDrop {
  readonly panelId: string;
  readonly placement: WorkbenchDropPlacement;
}

export interface WorkbenchPanelReference {
  readonly id: string;
  readonly target: WorkbenchPanelTarget;
}

let nextPanelSequence = 0;

function createPanelId() {
  nextPanelSequence += 1;
  return `panel-${Date.now().toString(36)}-${nextPanelSequence.toString(36)}`;
}

function isPanelTarget(value: unknown): value is WorkbenchPanelTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<WorkbenchPanelTarget>;
  if (candidate.kind === "empty") {
    return true;
  }
  if (candidate.kind === "collaborationCollaborator" || candidate.kind === "collaborationScratchpad") {
    return true;
  }
  if (candidate.kind === "file") {
    return typeof candidate.filePath === "string";
  }
  if (candidate.kind === "thread") {
    return typeof candidate.threadId === "string";
  }
  if (candidate.kind === "settings") {
    return candidate.scope === "global" || candidate.scope === "project";
  }

  return false;
}

function isDirection(value: unknown): value is "horizontal" | "vertical" {
  return value === "horizontal" || value === "vertical";
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeNode(value: unknown): WorkbenchMainLayoutNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<WorkbenchMainLayoutNode>;
  const id = typeof candidate.id === "string" && candidate.id ? candidate.id : createPanelId();
  if (candidate.type === "leaf" && isPanelTarget(candidate.target)) {
    return {
      id,
      target: candidate.target,
      type: "leaf",
    };
  }

  if (candidate.type === "split" && isDirection(candidate.direction)) {
    const first = normalizeNode(candidate.first);
    const second = normalizeNode(candidate.second);
    if (!first) {
      return second;
    }
    if (!second) {
      return first;
    }

    return {
      direction: candidate.direction,
      first,
      firstFr: normalizePositiveNumber(candidate.firstFr),
      firstMinimized: candidate.firstMinimized === true || undefined,
      id,
      second,
      secondFr: normalizePositiveNumber(candidate.secondFr),
      secondMinimized: candidate.secondMinimized === true || undefined,
      type: "split",
    };
  }

  return null;
}

function getFirstLeaf(node: WorkbenchMainLayoutNode): WorkbenchPanelReference {
  if (node.type === "leaf") {
    return {
      id: node.id,
      target: node.target,
    };
  }

  return getFirstLeaf(node.first);
}

function hasPanel(node: WorkbenchMainLayoutNode, panelId: string): boolean {
  if (node.id === panelId) {
    return true;
  }
  if (node.type === "leaf") {
    return false;
  }

  return hasPanel(node.first, panelId) || hasPanel(node.second, panelId);
}

function getSplitDirection(placement: WorkbenchDropPlacement): "horizontal" | "vertical" {
  return placement === "left" || placement === "right" ? "horizontal" : "vertical";
}

function shouldInsertBefore(placement: WorkbenchDropPlacement) {
  return placement === "left" || placement === "top";
}

function targetsEqual(left: WorkbenchPanelTarget, right: WorkbenchPanelTarget) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.filePath === right.filePath;
  }
  if (left.kind === "thread" && right.kind === "thread") {
    return left.threadId === right.threadId;
  }
  if (left.kind === "settings" && right.kind === "settings") {
    return left.scope === right.scope;
  }
  if (left.kind === "collaborationCollaborator" || left.kind === "collaborationScratchpad") {
    return true;
  }

  return left.kind === "empty";
}

function removeMatchingTarget(
  node: WorkbenchMainLayoutNode,
  target: WorkbenchPanelTarget,
): WorkbenchMainLayoutNode | null {
  if (node.type === "leaf") {
    return targetsEqual(node.target, target) ? null : node;
  }

  const first = removeMatchingTarget(node.first, target);
  const second = removeMatchingTarget(node.second, target);
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  if (first === node.first && second === node.second) {
    return node;
  }

  return {
    ...node,
    first,
    second,
  };
}

function replaceOrSplitNode(
  node: WorkbenchMainLayoutNode,
  drop: WorkbenchMainLayoutDrop,
  target: WorkbenchPanelTarget,
): WorkbenchMainLayoutNode {
  if (node.id !== drop.panelId) {
    if (node.type === "leaf") {
      return node;
    }

    const first = replaceOrSplitNode(node.first, drop, target);
    const second = replaceOrSplitNode(node.second, drop, target);
    if (first === node.first && second === node.second) {
      return node;
    }

    return {
      ...node,
      first,
      second,
    };
  }

  if (node.type !== "leaf" || drop.placement === "center") {
    return {
      id: node.type === "leaf" ? node.id : createPanelId(),
      target,
      type: "leaf",
    };
  }

  const inserted: WorkbenchMainLayoutNode = {
    id: createPanelId(),
    target,
    type: "leaf",
  };
  const direction = getSplitDirection(drop.placement);
  const insertedFirst = shouldInsertBefore(drop.placement);

  return {
    direction,
    first: insertedFirst ? inserted : node,
    id: createPanelId(),
    second: insertedFirst ? node : inserted,
    type: "split",
  };
}

function flattenPanels(node: WorkbenchMainLayoutNode): WorkbenchPanelReference[] {
  if (node.type === "leaf") {
    return [{
      id: node.id,
      target: node.target,
    }];
  }

  return [
    ...flattenPanels(node.first),
    ...flattenPanels(node.second),
  ];
}

function resizeSplitNode(
  node: WorkbenchMainLayoutNode,
  splitId: string,
  firstPercent: number,
): WorkbenchMainLayoutNode {
  if (node.type === "leaf") {
    return node;
  }

  if (node.id === splitId) {
    const firstFr = Math.min(95, Math.max(5, firstPercent));
    return {
      ...node,
      firstFr,
      secondFr: 100 - firstFr,
    };
  }

  const first = resizeSplitNode(node.first, splitId, firstPercent);
  const second = resizeSplitNode(node.second, splitId, firstPercent);
  if (first === node.first && second === node.second) {
    return node;
  }

  return {
    ...node,
    first,
    second,
  };
}

function WorkbenchMainLayout(target: WorkbenchPanelTarget = { kind: "empty" }): WorkbenchMainLayout {
  const root: WorkbenchMainLayoutNode = {
    id: createPanelId(),
    target,
    type: "leaf",
  };

  return {
    focusedPanelId: root.id,
    root,
  };
}

namespace WorkbenchMainLayout {
  export function fromTarget(target: WorkbenchPanelTarget): WorkbenchMainLayout {
    return WorkbenchMainLayout(target);
  }

  export function normalize(value: unknown, fallbackTarget: WorkbenchPanelTarget = { kind: "empty" }): WorkbenchMainLayout {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return WorkbenchMainLayout(fallbackTarget);
    }

    const candidate = value as Partial<WorkbenchMainLayout>;
    const root = normalizeNode(candidate.root);
    if (!root) {
      return WorkbenchMainLayout(fallbackTarget);
    }

    return {
      focusedPanelId: typeof candidate.focusedPanelId === "string" && hasPanel(root, candidate.focusedPanelId)
        ? candidate.focusedPanelId
        : getFirstLeaf(root).id,
      root,
    };
  }

  export function panels(layout: WorkbenchMainLayout) {
    return flattenPanels(layout.root);
  }

  export function findPanel(layout: WorkbenchMainLayout, panelId: string): WorkbenchPanelReference | null {
    return panels(layout).find((panel) => panel.id === panelId) ?? null;
  }

  export function focusPanel(layout: WorkbenchMainLayout, panelId: string): WorkbenchMainLayout {
    return hasPanel(layout.root, panelId)
      ? { ...layout, focusedPanelId: panelId }
      : layout;
  }

  export function applyDrop(
    layout: WorkbenchMainLayout,
    drop: WorkbenchMainLayoutDrop,
    target: WorkbenchPanelTarget,
  ): WorkbenchMainLayout {
    const dedupedRoot = target.kind === "file" || target.kind === "thread"
      ? removeMatchingTarget(layout.root, target) ?? layout.root
      : layout.root;
    const targetRoot = hasPanel(dedupedRoot, drop.panelId)
      ? dedupedRoot
      : layout.root;
    const nextRoot = replaceOrSplitNode(targetRoot, drop, target);
    const focusedPanel = panels({
      focusedPanelId: layout.focusedPanelId,
      root: nextRoot,
    }).find((panel) => targetsEqual(panel.target, target));

    return {
      focusedPanelId: focusedPanel?.id ?? getFirstLeaf(nextRoot).id,
      root: nextRoot,
    };
  }

  export function replaceFocusedPanel(layout: WorkbenchMainLayout, target: WorkbenchPanelTarget): WorkbenchMainLayout {
    return applyDrop(layout, {
      panelId: layout.focusedPanelId,
      placement: "center",
    }, target);
  }

  export function resizeSplit(layout: WorkbenchMainLayout, splitId: string, firstPercent: number): WorkbenchMainLayout {
    return {
      ...layout,
      root: resizeSplitNode(layout.root, splitId, firstPercent),
    };
  }

  export function closePanel(layout: WorkbenchMainLayout, panelId: string): WorkbenchMainLayout {
    const nextRoot = removePanel(layout.root, panelId) ?? {
      id: createPanelId(),
      target: { kind: "empty" },
      type: "leaf" as const,
    };

    return {
      focusedPanelId: hasPanel(nextRoot, layout.focusedPanelId) ? layout.focusedPanelId : getFirstLeaf(nextRoot).id,
      root: nextRoot,
    };
  }
}

function removePanel(node: WorkbenchMainLayoutNode, panelId: string): WorkbenchMainLayoutNode | null {
  if (node.id === panelId) {
    return null;
  }
  if (node.type === "leaf") {
    return node;
  }

  const first = removePanel(node.first, panelId);
  const second = removePanel(node.second, panelId);
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  if (first === node.first && second === node.second) {
    return node;
  }

  return {
    ...node,
    first,
    second,
  };
}

export default WorkbenchMainLayout;
