/*
 * Exports:
 * - WorkbenchMosaicPanelTarget/WorkbenchMosaicNode/WorkbenchMosaicParseResult: URL-safe mosaic route tree contracts. Keywords: workbench, mosaic, route, split.
 * - createWorkbenchMosaicTarget/createWorkbenchMosaicSplit: construct normalized mosaic route nodes. Keywords: mosaic, builder, normalize.
 * - parseWorkbenchMosaicRouteExpression/serializeWorkbenchMosaicRouteExpression: parse and write bracketed mosaic URL expressions. Keywords: parser, serializer, URL.
 */

import type { WorkbenchPanelTarget } from "../layout/workbench-layout";
import { WorkbenchThreadTargetSchema, type WorkbenchThreadTarget } from "../thread/thread-state";

export type WorkbenchMosaicPanelTarget = Extract<WorkbenchPanelTarget, { readonly kind: "file" } | { readonly kind: "thread" }>;

export interface WorkbenchMosaicNodeOptions {
  readonly minimized?: boolean;
  readonly weightPercent?: number;
  readonly zoomDelta?: number;
}

export type WorkbenchMosaicNode =
  | WorkbenchMosaicNodeOptions & {
    readonly target: WorkbenchMosaicPanelTarget;
    readonly type: "target";
  }
  | WorkbenchMosaicNodeOptions & {
    readonly children: readonly WorkbenchMosaicNode[];
    readonly type: "split";
  };

export type WorkbenchMosaicParseResult =
  | {
    readonly node: WorkbenchMosaicNode;
    readonly ok: true;
  }
  | {
    readonly error: string;
    readonly ok: false;
  };

type MosaicNodeParseResult =
  | {
    readonly index: number;
    readonly node: WorkbenchMosaicNode;
    readonly ok: true;
  }
  | {
    readonly error: string;
    readonly ok: false;
  };

export function createWorkbenchMosaicTarget(target: WorkbenchMosaicPanelTarget, options: WorkbenchMosaicNodeOptions = {}): WorkbenchMosaicNode {
  return {
    ...options,
    target,
    type: "target",
  };
}

export function createWorkbenchMosaicSplit(children: readonly WorkbenchMosaicNode[], options: WorkbenchMosaicNodeOptions = {}): WorkbenchMosaicNode {
  return {
    children,
    ...options,
    type: "split",
  };
}

function getWorkbenchMosaicNodeOptions(node: WorkbenchMosaicNode): WorkbenchMosaicNodeOptions {
  return {
    minimized: node.minimized,
    weightPercent: node.weightPercent,
    zoomDelta: node.zoomDelta,
  };
}

function decodeMosaicValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function encodeMosaicValue(value: string) {
  return encodeURIComponent(value);
}

function parseMosaicTarget(rawValue: string): WorkbenchMosaicPanelTarget | null {
  if (rawValue.startsWith("thread/")) {
    const rawThread = rawValue.slice("thread/".length);
    const rawSegments = rawThread.split("/");
    let target: WorkbenchThreadTarget | null = null;
    if (rawSegments[0] === "new") {
      if (rawSegments.length === 1) target = { kind: "new" };
      if (rawSegments.length === 2) {
        const draftId = decodeMosaicValue(rawSegments[1] ?? "");
        const parsed = WorkbenchThreadTargetSchema.safeParse({ draftId, kind: "draft" });
        if (parsed.success) target = parsed.data;
      }
    } else if (rawSegments.length === 3 && rawSegments[1] === "sub") {
      const parentThreadId = decodeMosaicValue(rawSegments[0] ?? "");
      const threadId = decodeMosaicValue(rawSegments[2] ?? "");
      if (parentThreadId && threadId) target = { kind: "subagent", parentThreadId, threadId };
    } else if (rawSegments.length === 1) {
      const threadId = decodeMosaicValue(rawThread);
      if (threadId) target = { kind: "provider", threadId };
    }
    return target ? { kind: "thread", target } : null;
  }

  if (rawValue.startsWith("file/")) {
    const filePath = decodeMosaicValue(rawValue.slice("file/".length));
    return filePath ? { filePath, kind: "file" } : null;
  }

  return null;
}

function readMosaicOptions(expression: string, startIndex: number): { index: number; options: WorkbenchMosaicNodeOptions } {
  let index = startIndex;
  let rawOptions = "";
  while (index < expression.length && expression[index] !== "," && expression[index] !== "]") {
    rawOptions += expression[index];
    index += 1;
  }

  if (!rawOptions) {
    return { index, options: {} };
  }

  const options: {
    minimized?: boolean;
    zoomDelta?: number;
  } = {};
  for (const part of rawOptions.split("&")) {
    const [key, value = ""] = part.split("=", 2);
    if (key === "minimize" || key === "minimized") {
      options.minimized = true;
      continue;
    }
    if (key === "zoom") {
      const zoomDelta = Number.parseInt(value, 10);
      if (Number.isFinite(zoomDelta) && zoomDelta) {
        options.zoomDelta = zoomDelta;
      }
    }
  }

  return { index, options };
}

function readMosaicWeight(expression: string, startIndex: number): { index: number; weightPercent?: number } {
  let index = startIndex;
  let rawWeight = "";
  while (index < expression.length && /[0-9.]/.test(expression[index])) {
    rawWeight += expression[index];
    index += 1;
  }

  if (!rawWeight || expression[index] !== "[") {
    return { index: startIndex };
  }

  const weightPercent = Number.parseFloat(rawWeight);
  return {
    index,
    weightPercent: Number.isFinite(weightPercent) && weightPercent > 0 ? weightPercent : undefined,
  };
}

function canStartMosaicNode(expression: string, index: number, rawTargetValue: string) {
  return expression[index] === "["
    || (!rawTargetValue && readMosaicWeight(expression, index).index !== index);
}

function parseMosaicNode(expression: string, startIndex: number): MosaicNodeParseResult {
  const weight = readMosaicWeight(expression, startIndex);
  if (expression[weight.index] !== "[") {
    return {
      error: `Expected mosaic node at index ${startIndex}.`,
      ok: false,
    };
  }

  let index = weight.index + 1;
  const children: WorkbenchMosaicNode[] = [];
  let rawTargetValue = "";
  while (index < expression.length) {
    const character = expression[index];
    if (canStartMosaicNode(expression, index, rawTargetValue)) {
      if (rawTargetValue.trim()) {
        return {
          error: `Unexpected mosaic target text before index ${index}.`,
          ok: false,
        };
      }

      const nestedNode = parseMosaicNode(expression, index);
      if (!nestedNode.ok) {
        return nestedNode;
      }

      children.push(nestedNode.node);
      index = nestedNode.index;
      rawTargetValue = "";
      continue;
    }

    if (character === ",") {
      if (rawTargetValue.trim()) {
        return {
          error: `Unexpected comma inside mosaic target at index ${index}.`,
          ok: false,
        };
      }

      index += 1;
      continue;
    }

    if (character === "]") {
      if (children.length) {
        if (rawTargetValue.trim()) {
          return {
            error: `Unexpected mosaic target text before index ${index}.`,
            ok: false,
          };
        }

        const options = readMosaicOptions(expression, index + 1);
        return {
          index: options.index,
          node: createWorkbenchMosaicSplit(children, {
            ...options.options,
            weightPercent: weight.weightPercent,
          }),
          ok: true,
        };
      }

      const target = parseMosaicTarget(rawTargetValue);
      if (!target) {
        return {
          error: `Unknown mosaic target: ${rawTargetValue || "(empty)"}.`,
          ok: false,
        };
      }

      const options = readMosaicOptions(expression, index + 1);
      return {
        index: options.index,
        node: createWorkbenchMosaicTarget(target, {
          ...options.options,
          weightPercent: weight.weightPercent,
        }),
        ok: true,
      };
    }

    rawTargetValue += character;
    index += 1;
  }

  return {
    error: "Unclosed mosaic node.",
    ok: false,
  };
}

export function parseWorkbenchMosaicRouteExpression(expression: string): WorkbenchMosaicParseResult {
  const children: WorkbenchMosaicNode[] = [];
  let index = 0;
  while (index < expression.length) {
    if (expression[index] === ",") {
      index += 1;
      continue;
    }

    const parsedNode = parseMosaicNode(expression, index);
    if (!parsedNode.ok) {
      return parsedNode;
    }

    children.push(parsedNode.node);
    index = parsedNode.index;
  }

  if (!children.length) {
    return {
      error: "Mosaic route is empty.",
      ok: false,
    };
  }

  return {
    node: normalizeWorkbenchMosaicWeights(createWorkbenchMosaicSplit(children)),
    ok: true,
  };
}

function normalizeWorkbenchMosaicWeights(node: WorkbenchMosaicNode): WorkbenchMosaicNode {
  if (node.type === "target") {
    return node;
  }

  const children = node.children.map(normalizeWorkbenchMosaicWeights);
  const explicitWeightTotal = children.reduce((sum, child) => sum + (child.weightPercent ?? 0), 0);
  if (explicitWeightTotal <= 100) {
    return createWorkbenchMosaicSplit(children, getWorkbenchMosaicNodeOptions(node));
  }

  return createWorkbenchMosaicSplit(children.map((child) => (
    child.weightPercent
      ? { ...child, weightPercent: (child.weightPercent / explicitWeightTotal) * 100 }
      : child
  )), getWorkbenchMosaicNodeOptions(node));
}

function formatWeightPercent(weightPercent: number) {
  return Number.isInteger(weightPercent) ? String(weightPercent) : String(Number(weightPercent.toFixed(2)));
}

function serializeMosaicOptions(node: WorkbenchMosaicNode) {
  const parts: string[] = [];
  if (node.zoomDelta) {
    parts.push(`zoom=${node.zoomDelta}`);
  }
  if (node.minimized) {
    parts.push("minimize");
  }

  return parts.length ? parts.join("&") : "";
}

function serializeWorkbenchMosaicNode(node: WorkbenchMosaicNode): string {
  const weightPrefix = node.weightPercent ? formatWeightPercent(node.weightPercent) : "";
  const options = serializeMosaicOptions(node);
  if (node.type === "split") {
    return `${weightPrefix}[${node.children.map(serializeWorkbenchMosaicNode).join(",")}]${options}`;
  }

  if (node.target.kind === "file") {
    return `${weightPrefix}[file/${encodeMosaicValue(node.target.filePath)}]${options}`;
  }

  const threadTarget = node.target.target;
  const serializedThread = threadTarget.kind === "new"
    ? "new"
    : threadTarget.kind === "draft"
      ? `new/${encodeMosaicValue(threadTarget.draftId)}`
      : threadTarget.kind === "subagent"
        ? `${encodeMosaicValue(threadTarget.parentThreadId)}/sub/${encodeMosaicValue(threadTarget.threadId)}`
        : encodeMosaicValue(threadTarget.threadId);
  return `${weightPrefix}[thread/${serializedThread}]${options}`;
}

export function serializeWorkbenchMosaicRouteExpression(node: WorkbenchMosaicNode): string {
  if (node.type === "split") {
    return node.children.map(serializeWorkbenchMosaicNode).join(",");
  }

  return serializeWorkbenchMosaicNode(node);
}
