/*
 * Exports:
 * - WorkbenchMosaicLayoutProjection: renderable split layout plus panel path lookup for a mosaic URL tree. Keywords: workbench, mosaic, layout.
 * - createWorkbenchMainLayoutFromMosaic: convert a depth-directed mosaic tree into the split layout renderer model. Keywords: mosaic, split, projection.
 * - applyWorkbenchMosaicDrop: apply a panel drop to a mosaic tree while preserving depth-based split directions. Keywords: mosaic, drag drop, URL state.
 * - moveWorkbenchMosaicTarget: reposition an existing mosaic target without duplicating it. Keywords: mosaic, panel move, drag.
 * - closeWorkbenchMosaicTarget: remove one mosaic target and return the remaining tree. Keywords: mosaic, close panel.
 * - replaceWorkbenchMosaicTarget: replace one target inside a mosaic tree. Keywords: mosaic, draft, materialize.
 */

import type {
  WorkbenchDropPlacement,
  WorkbenchMainLayout,
  WorkbenchMainLayoutNode,
  WorkbenchPanelTarget,
} from "./workbench-layout";
import type {
  WorkbenchMosaicNode,
  WorkbenchMosaicNodeOptions,
  WorkbenchMosaicPanelTarget,
} from "../navigation/workbench-mosaic-route";
import {
  createWorkbenchMosaicSplit,
  createWorkbenchMosaicTarget,
} from "../navigation/workbench-mosaic-route";

export interface WorkbenchMosaicLayoutProjection {
  readonly layout: WorkbenchMainLayout;
  readonly panelPathsById: Readonly<Record<string, readonly number[]>>;
  readonly resizeGroupsById: Readonly<Record<string, WorkbenchMosaicResizeGroup>>;
}

export interface WorkbenchMosaicResizeGroup {
  readonly firstIndexes: readonly number[];
  readonly groupPath: readonly number[];
  readonly secondIndexes: readonly number[];
}

function createStableLayoutHash(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function sanitizeLayoutIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

function formatLayoutPathId(path: readonly number[]) {
  return path.length ? path.join("-") : "root";
}

function createMosaicTargetLayoutNodeId(target: WorkbenchMosaicPanelTarget) {
  const targetValue = target.kind === "file" ? target.filePath : target.threadId;
  const stableKey = `${target.kind}:${targetValue}`;
  return `mosaic-panel-${target.kind}-${createStableLayoutHash(stableKey)}-${sanitizeLayoutIdPart(targetValue).slice(0, 32)}`;
}

function createMosaicSplitLayoutNodeId(groupPath: readonly number[], offset: number) {
  return `mosaic-split-${formatLayoutPathId(groupPath)}-${offset}`;
}

function createMosaicEmptyLayoutNodeId(path: readonly number[]) {
  return `mosaic-empty-${formatLayoutPathId(path)}`;
}

function isMosaicTarget(target: WorkbenchPanelTarget): target is WorkbenchMosaicPanelTarget {
  return target.kind === "file" || target.kind === "thread";
}

function targetsEqual(left: WorkbenchMosaicPanelTarget, right: WorkbenchMosaicPanelTarget) {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "file" && right.kind === "file") {
    return left.filePath === right.filePath;
  }

  return left.kind === "thread" && right.kind === "thread" && left.threadId === right.threadId;
}

function containsTarget(node: WorkbenchMosaicNode, target: WorkbenchMosaicPanelTarget): boolean {
  if (node.type === "target") {
    return targetsEqual(node.target, target);
  }

  return node.children.some((child) => containsTarget(child, target));
}

function findTargetPath(node: WorkbenchMosaicNode, target: WorkbenchMosaicPanelTarget, path: readonly number[] = []): readonly number[] | null {
  if (node.type === "target") {
    return targetsEqual(node.target, target) ? path : null;
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const childPath = findTargetPath(node.children[index], target, [...path, index]);
    if (childPath) {
      return childPath;
    }
  }

  return null;
}

function removeTargetFromNode(node: WorkbenchMosaicNode, target: WorkbenchMosaicPanelTarget): WorkbenchMosaicNode | null {
  if (node.type === "target") {
    return targetsEqual(node.target, target) ? null : node;
  }

  const children = node.children
    .map((child) => removeTargetFromNode(child, target))
    .filter((child): child is WorkbenchMosaicNode => Boolean(child));
  if (!children.length) {
    return null;
  }
  if (children.length === 1) {
    return children[0];
  }

  return createWorkbenchMosaicSplit(children, getMosaicNodeOptions(node));
}

function isHorizontalPlacement(placement: WorkbenchDropPlacement) {
  return placement === "left" || placement === "right";
}

function shouldInsertBefore(placement: WorkbenchDropPlacement) {
  return placement === "left" || placement === "top";
}

function getMosaicSplitDirection(depth: number): "horizontal" | "vertical" {
  return depth % 2 === 0 ? "horizontal" : "vertical";
}

function getMosaicNodeOptions(node: WorkbenchMosaicNode): WorkbenchMosaicNodeOptions {
  return {
    minimized: node.minimized,
    weightPercent: node.weightPercent,
    zoomDelta: node.zoomDelta,
  };
}

function getNormalizedChildWeights(children: readonly WorkbenchMosaicNode[]) {
  const fallbackWeight = children.length ? 100 / children.length : 100;
  const rawWeights = children.map((child) => child.weightPercent && child.weightPercent > 0 ? child.weightPercent : fallbackWeight);
  const total = rawWeights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    return children.map(() => fallbackWeight);
  }

  return rawWeights.map((weight) => (weight / total) * 100);
}

function isMinimizedLeaf(node: WorkbenchMainLayoutNode) {
  return node.type === "leaf" && Boolean(node.mosaicPanel?.minimized);
}

function buildLayoutNode(
  node: WorkbenchMosaicNode,
  depth: number,
  path: readonly number[],
  panelPathsById: Record<string, readonly number[]>,
  resizeGroupsById: Record<string, WorkbenchMosaicResizeGroup>,
  parentDirection?: "horizontal" | "vertical",
): WorkbenchMainLayoutNode {
  if (node.type === "target") {
    const id = createMosaicTargetLayoutNodeId(node.target);
    panelPathsById[id] = path;
    return {
      id,
      mosaicPanel: {
        minimized: node.minimized,
        parentDirection,
        zoomDelta: node.zoomDelta,
      },
      target: node.target,
      type: "leaf",
    };
  }

  const children = node.children.filter(Boolean);
  if (!children.length) {
    return {
      id: createMosaicEmptyLayoutNodeId(path),
      target: { kind: "empty" },
      type: "leaf",
    };
  }

  if (children.length === 1) {
    return buildLayoutNode(children[0], depth + 1, [...path, 0], panelPathsById, resizeGroupsById, parentDirection);
  }

  const direction = getMosaicSplitDirection(depth);
  const weights = getNormalizedChildWeights(children);
  return buildSiblingGroup(children, weights, depth, path, 0, panelPathsById, resizeGroupsById, direction);
}

function buildSiblingGroup(
  children: readonly WorkbenchMosaicNode[],
  weights: readonly number[],
  depth: number,
  groupPath: readonly number[],
  offset: number,
  panelPathsById: Record<string, readonly number[]>,
  resizeGroupsById: Record<string, WorkbenchMosaicResizeGroup>,
  direction: "horizontal" | "vertical",
): WorkbenchMainLayoutNode {
  if (children.length === 1) {
    return buildLayoutNode(children[0], depth + 1, [...groupPath, offset], panelPathsById, resizeGroupsById, direction);
  }

  const firstChild = children[0];
  const secondChildren = children.slice(1);
  const firstNode = buildLayoutNode(firstChild, depth + 1, [...groupPath, offset], panelPathsById, resizeGroupsById, direction);
  const secondNode = secondChildren.length === 1
    ? buildLayoutNode(secondChildren[0], depth + 1, [...groupPath, offset + 1], panelPathsById, resizeGroupsById, direction)
    : buildSiblingGroup(secondChildren, weights.slice(1), depth, groupPath, offset + 1, panelPathsById, resizeGroupsById, direction);
  const id = createMosaicSplitLayoutNodeId(groupPath, offset);
  const secondWeight = weights.slice(1).reduce((sum, weight) => sum + weight, 0);
  resizeGroupsById[id] = {
    firstIndexes: [offset],
    groupPath,
    secondIndexes: secondChildren.map((_, index) => offset + index + 1),
  };

  return {
    direction,
    first: firstNode,
    firstFr: weights[0],
    firstMinimized: isMinimizedLeaf(firstNode),
    id,
    second: secondNode,
    secondFr: secondWeight,
    secondMinimized: isMinimizedLeaf(secondNode),
    type: "split",
  };
}

function getFirstPanelId(node: WorkbenchMainLayoutNode): string {
  if (node.type === "leaf") {
    return node.id;
  }

  return getFirstPanelId(node.first);
}

export function createWorkbenchMainLayoutFromMosaic(node: WorkbenchMosaicNode): WorkbenchMosaicLayoutProjection {
  const panelPathsById: Record<string, readonly number[]> = {};
  const resizeGroupsById: Record<string, WorkbenchMosaicResizeGroup> = {};
  const root = buildLayoutNode(node, 0, [], panelPathsById, resizeGroupsById);

  return {
    layout: {
      focusedPanelId: getFirstPanelId(root),
      root,
    },
    panelPathsById,
    resizeGroupsById,
  };
}

function applyDropToNode(
  node: WorkbenchMosaicNode,
  path: readonly number[],
  placement: WorkbenchDropPlacement,
  target: WorkbenchMosaicPanelTarget,
  depth: number,
): WorkbenchMosaicNode {
  const insertedNode = createWorkbenchMosaicTarget(target);
  if (!path.length || node.type === "target") {
    if (placement === "center") {
      return insertedNode;
    }

    if (isHorizontalPlacement(placement) === (getMosaicSplitDirection(depth) === "horizontal")) {
      return createWorkbenchMosaicSplit(shouldInsertBefore(placement)
        ? [insertedNode, node]
        : [node, insertedNode]);
    }

    const nestedSplit = createWorkbenchMosaicSplit(shouldInsertBefore(placement)
      ? [insertedNode, node]
      : [node, insertedNode]);
    return createWorkbenchMosaicSplit([nestedSplit]);
  }

  const [childIndex, ...childPath] = path;
  const children = [...node.children];
  const child = children[childIndex];
  if (!child) {
    return node;
  }

  if (childPath.length) {
    children[childIndex] = applyDropToNode(child, childPath, placement, target, depth + 1);
    return createWorkbenchMosaicSplit(children);
  }

  if (placement === "center") {
    children[childIndex] = insertedNode;
    return createWorkbenchMosaicSplit(children);
  }

  const parentDirectionMatchesPlacement = isHorizontalPlacement(placement) === (getMosaicSplitDirection(depth) === "horizontal");
  if (parentDirectionMatchesPlacement) {
    children.splice(shouldInsertBefore(placement) ? childIndex : childIndex + 1, 0, insertedNode);
    return createWorkbenchMosaicSplit(children);
  }

  children[childIndex] = createWorkbenchMosaicSplit(shouldInsertBefore(placement)
    ? [insertedNode, child]
    : [child, insertedNode]);
  return createWorkbenchMosaicSplit(children);
}

export function applyWorkbenchMosaicDrop(
  node: WorkbenchMosaicNode,
  panelPath: readonly number[],
  placement: WorkbenchDropPlacement,
  target: WorkbenchPanelTarget,
): WorkbenchMosaicNode {
  if (!isMosaicTarget(target) || containsTarget(node, target)) {
    return node;
  }

  return applyDropToNode(node, panelPath, placement, target, 0);
}

export function moveWorkbenchMosaicTarget(
  node: WorkbenchMosaicNode,
  dropTarget: WorkbenchMosaicPanelTarget,
  placement: WorkbenchDropPlacement,
  target: WorkbenchPanelTarget,
): WorkbenchMosaicNode {
  if (!isMosaicTarget(target) || targetsEqual(dropTarget, target) || !containsTarget(node, target)) {
    return node;
  }

  const prunedNode = removeTargetFromNode(node, target);
  if (!prunedNode) {
    return node;
  }

  const dropPath = findTargetPath(prunedNode, dropTarget);
  if (!dropPath) {
    return node;
  }

  return applyDropToNode(prunedNode, dropPath, placement, target, 0);
}

export function closeWorkbenchMosaicTarget(
  node: WorkbenchMosaicNode,
  target: WorkbenchPanelTarget,
): WorkbenchMosaicNode | null {
  return isMosaicTarget(target) ? removeTargetFromNode(node, target) : node;
}

export function replaceWorkbenchMosaicTarget(
  node: WorkbenchMosaicNode,
  previousTarget: WorkbenchPanelTarget,
  nextTarget: WorkbenchPanelTarget,
): WorkbenchMosaicNode {
  if (!isMosaicTarget(previousTarget) || !isMosaicTarget(nextTarget)) {
    return node;
  }

  if (node.type === "target") {
    return targetsEqual(node.target, previousTarget)
      ? createWorkbenchMosaicTarget(nextTarget, getMosaicNodeOptions(node))
      : node;
  }

  return createWorkbenchMosaicSplit(
    node.children.map((child) => replaceWorkbenchMosaicTarget(child, previousTarget, nextTarget)),
    getMosaicNodeOptions(node),
  );
}

function updateNodeAtPath(
  node: WorkbenchMosaicNode,
  path: readonly number[],
  update: (node: WorkbenchMosaicNode) => WorkbenchMosaicNode,
): WorkbenchMosaicNode {
  if (!path.length) {
    return update(node);
  }

  if (node.type !== "split") {
    return node;
  }

  const [childIndex, ...childPath] = path;
  const child = node.children[childIndex];
  if (!child) {
    return node;
  }

  const children = [...node.children];
  children[childIndex] = updateNodeAtPath(child, childPath, update);
  return createWorkbenchMosaicSplit(children, getMosaicNodeOptions(node));
}

function updateSplitAtPath(
  node: WorkbenchMosaicNode,
  path: readonly number[],
  update: (node: Extract<WorkbenchMosaicNode, { readonly type: "split" }>) => WorkbenchMosaicNode,
): WorkbenchMosaicNode {
  return updateNodeAtPath(node, path, (targetNode) => targetNode.type === "split" ? update(targetNode) : targetNode);
}

function distributeWeight(total: number, currentWeights: readonly number[]) {
  const currentTotal = currentWeights.reduce((sum, weight) => sum + weight, 0);
  if (currentTotal <= 0) {
    const equalWeight = currentWeights.length ? total / currentWeights.length : total;
    return currentWeights.map(() => equalWeight);
  }

  return currentWeights.map((weight) => (weight / currentTotal) * total);
}

export function applyWorkbenchMosaicResize(
  node: WorkbenchMosaicNode,
  resizeGroup: WorkbenchMosaicResizeGroup,
  firstPercent: number,
): WorkbenchMosaicNode {
  const nextFirstPercent = Math.min(95, Math.max(5, firstPercent));
  return updateSplitAtPath(node, resizeGroup.groupPath, (splitNode) => {
    const weights = getNormalizedChildWeights(splitNode.children);
    const firstWeights = distributeWeight(nextFirstPercent, resizeGroup.firstIndexes.map((index) => weights[index] ?? 0));
    const secondWeights = distributeWeight(100 - nextFirstPercent, resizeGroup.secondIndexes.map((index) => weights[index] ?? 0));
    const children = splitNode.children.map((child, index) => {
      const firstIndex = resizeGroup.firstIndexes.indexOf(index);
      if (firstIndex >= 0) {
        return { ...child, weightPercent: firstWeights[firstIndex] };
      }

      const secondIndex = resizeGroup.secondIndexes.indexOf(index);
      if (secondIndex >= 0) {
        return { ...child, weightPercent: secondWeights[secondIndex] };
      }

      return child;
    });

    return createWorkbenchMosaicSplit(children, getMosaicNodeOptions(splitNode));
  });
}

export function updateWorkbenchMosaicPanelOptions(
  node: WorkbenchMosaicNode,
  panelPath: readonly number[],
  options: WorkbenchMosaicNodeOptions,
): WorkbenchMosaicNode {
  return updateNodeAtPath(node, panelPath, (targetNode) => ({
    ...targetNode,
    ...options,
  }));
}
