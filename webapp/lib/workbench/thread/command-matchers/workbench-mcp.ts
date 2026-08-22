/*
 * Exports:
 * - getWorkbenchMcpCommandRoute/shouldUseWorkbenchMcpSpecializedRenderer: resolve a recorded wb MCP call and keep failed Recall calls on the generic MCP error surface. Keywords: workbench, MCP, command, route, failure.
 * - getWorkbenchMcpCommandDisplay: match a simple recorded wb MCP call to its shared summary presentation. Keywords: workbench, MCP, command, rendering.
 */
import type { JsonValue } from "../../../codex/generated/app-server/serde_json/JsonValue";

import type { ThreadCommandSummaryDisplay } from "./types";
import {
  getWorkbenchCommandRoute,
  getWorkbenchCommandSummaryDisplay,
  isWorkbenchCommandPresentationName,
  type WorkbenchCommandRoute,
} from "./workbench-command-rendering";

export function getWorkbenchMcpCommandRoute({
  argumentsValue,
  server,
  tool,
}: {
  argumentsValue: JsonValue;
  server: string;
  tool: string;
}) {
  if (server !== "wb" || !isWorkbenchCommandPresentationName(tool)) return null;
  return getWorkbenchCommandRoute(tool, argumentsValue);
}

export function shouldUseWorkbenchMcpSpecializedRenderer(
  route: WorkbenchCommandRoute | null,
  isFailure: boolean,
) {
  if (route?.kind !== "specialized") return false;
  return !isFailure
    || route.operation.kind === "gitArc"
    || route.operation.kind === "threadTitle";
}

export function getWorkbenchMcpCommandDisplay({
  argumentsValue,
  server,
  tool,
}: {
  argumentsValue: JsonValue;
  server: string;
  tool: string;
}): ThreadCommandSummaryDisplay | null {
  if (server !== "wb" || !isWorkbenchCommandPresentationName(tool)) return null;
  return getWorkbenchCommandSummaryDisplay(tool, argumentsValue);
}
