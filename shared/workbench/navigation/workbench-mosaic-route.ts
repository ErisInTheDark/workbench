/*
 * Exports:
 * - WorkbenchMosaicPanelTarget/WorkbenchMosaicNode/WorkbenchMosaicParseResult: URL-safe mosaic route tree contracts.
 * - WorkbenchMosaicNodeOptions: panel sizing and presentation options.
 * - createWorkbenchMosaicTarget/createWorkbenchMosaicSplit: construct route nodes.
 * - parseWorkbenchMosaicRouteExpression/serializeWorkbenchMosaicRouteExpression: parse and write bracketed URL expressions.
 */

import type { WorkbenchPanelTarget } from "../layout/workbench-layout.ts";
import { z } from "zod";
import { LogicalProjectIdSchema, type LogicalProjectId } from "../identity.ts";
import { ProjectLocationReferenceSchema, type ProjectLocationReference } from "../project/project-location.ts";
import { WorkbenchThreadRouteTargetSchema, type WorkbenchThreadRouteTarget } from "../thread/thread-state.ts";

const RouteThreadReferenceSchema = z.string().brand<"ThreadReference">();

export type WorkbenchMosaicPanelTarget = Extract<WorkbenchPanelTarget, { readonly kind: "file" } | { readonly kind: "thread" }> & {
  readonly source?: { logicalProjectId: LogicalProjectId; location: ProjectLocationReference | null };
};

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
  if (target.source) {
    LogicalProjectIdSchema.parse(target.source.logicalProjectId);
    if (target.source.location) ProjectLocationReferenceSchema.parse(target.source.location);
    if (target.kind === "file" && !target.source.location) {
      throw new Error("A file mosaic pane needs a daemon location.");
    }
  }
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

function parseMosaicThreadTarget(rawThread: string): WorkbenchThreadRouteTarget | null {
    const rawSegments = rawThread.split("/");
    let target: WorkbenchThreadRouteTarget | null = null;
    if (rawSegments[0] === "new") {
      if (rawSegments.length === 1) target = { kind: "new" };
      if (rawSegments.length === 2) {
        const draftId = decodeMosaicValue(rawSegments[1] ?? "");
        const parsed = WorkbenchThreadRouteTargetSchema.safeParse({ draftId, kind: "draft" });
        if (parsed.success) target = parsed.data;
      }
    } else if (rawSegments.length === 3 && rawSegments[1] === "sub") {
      const parentThreadId = decodeMosaicValue(rawSegments[0] ?? "");
      const threadId = decodeMosaicValue(rawSegments[2] ?? "");
      if (parentThreadId && threadId) target = { kind: "subagent", parentThreadId: RouteThreadReferenceSchema.parse(parentThreadId), threadId: RouteThreadReferenceSchema.parse(threadId) };
    } else if (rawSegments.length === 1) {
      const threadId = decodeMosaicValue(rawThread);
      if (threadId) target = { kind: "provider", threadId: RouteThreadReferenceSchema.parse(threadId) };
    }
    return target;
}

function parseMosaicTarget(rawValue: string): WorkbenchMosaicPanelTarget | null {
  if (rawValue.startsWith("thread/id/")) {
    const target = parseMosaicThreadTarget(rawValue.slice("thread/id/".length));
    return target?.kind === "provider" || target?.kind === "subagent"
      ? { kind: "thread", target } : null;
  }
  if (rawValue.startsWith("file/at/") || rawValue.startsWith("thread/at/")) {
    const parts = rawValue.split("/");
    if (parts.length < 6) return null;
    const logicalProjectId = LogicalProjectIdSchema.safeParse(decodeMosaicValue(parts[2] ?? ""));
    const location = ProjectLocationReferenceSchema.safeParse({
      daemonId: decodeMosaicValue(parts[3] ?? ""), projectId: decodeMosaicValue(parts[4] ?? ""),
    });
    if (!logicalProjectId.success || !location.success) return null;
    const source = { logicalProjectId: logicalProjectId.data, location: location.data };
    if (parts[0] === "file" && parts.length === 6) {
      const filePath = decodeMosaicValue(parts[5] ?? "");
      return filePath ? { kind: "file", filePath, source } : null;
    }
    if (parts[0] === "thread") {
      const target = parseMosaicThreadTarget(parts.slice(5).join("/"));
      return target ? { kind: "thread", target, source } : null;
    }
    return null;
  }
  if (rawValue.startsWith("thread/logical/")) {
    const parts = rawValue.split("/");
    const logicalProjectId = LogicalProjectIdSchema.safeParse(decodeMosaicValue(parts[2] ?? ""));
    const target = parseMosaicThreadTarget(parts.slice(3).join("/"));
    if (!logicalProjectId.success || !target || target.kind === "provider" || target.kind === "subagent") return null;
    return { kind: "thread", target, source: { logicalProjectId: logicalProjectId.data, location: null } };
  }
  if (rawValue.startsWith("thread/")) {
    const target = parseMosaicThreadTarget(rawValue.slice("thread/".length));
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
    if (node.target.source?.location) {
      const { logicalProjectId, location } = node.target.source;
      return `${weightPrefix}[file/at/${encodeMosaicValue(logicalProjectId)}/${encodeMosaicValue(location.daemonId)}/${encodeMosaicValue(location.projectId)}/${encodeMosaicValue(node.target.filePath)}]${options}`;
    }
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
  if ((threadTarget.kind === "provider" || threadTarget.kind === "subagent") && !node.target.source) {
    return `${weightPrefix}[thread/id/${serializedThread}]${options}`;
  }
  if (node.target.source) {
    const { logicalProjectId, location } = node.target.source;
    return location
      ? `${weightPrefix}[thread/at/${encodeMosaicValue(logicalProjectId)}/${encodeMosaicValue(location.daemonId)}/${encodeMosaicValue(location.projectId)}/${serializedThread}]${options}`
      : `${weightPrefix}[thread/logical/${encodeMosaicValue(logicalProjectId)}/${serializedThread}]${options}`;
  }
  return `${weightPrefix}[thread/${serializedThread}]${options}`;
}

export function serializeWorkbenchMosaicRouteExpression(node: WorkbenchMosaicNode): string {
  if (node.type === "split") {
    return node.children.map(serializeWorkbenchMosaicNode).join(",");
  }

  return serializeWorkbenchMosaicNode(node);
}
