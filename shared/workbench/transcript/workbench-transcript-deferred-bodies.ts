/*
 * Exports:
 * - deferWorkbenchTranscriptEnvelopeBody: leave out a completed tool item's output rows when no collapsed summary reads them.
 */
import type { WorkbenchTranscriptItemEnvelope } from "../database/transcript/workbench-transcript-contract.ts";
import { WORKBENCH_QUESTIONNAIRE_TOOL_NAME } from "../thread/thread-questionnaire-history.ts";

/**
 * Workbench MCP tools whose collapsed cards derive from arguments or structured results only.
 * Every other wb tool reads its human output while collapsed (titles, waits, git arc, browse rows).
 */
const DEFERRABLE_WORKBENCH_TOOLS = new Set(["shell", "rg"]);

function isWorkbenchServer(server: string | null) {
  return server === "wb" || server === "wbex";
}

/** Returns the envelope without output rows plus its deferred-body marker, or null when the body must stay eager. */
export function deferWorkbenchTranscriptEnvelopeBody(
  envelope: WorkbenchTranscriptItemEnvelope,
): WorkbenchTranscriptItemEnvelope | null {
  const { rows } = envelope.snapshot;
  const root = rows.threadItems[0];
  const source = rows.threadOperationCallableToolSources[0];
  if (!root || !source || source.state !== "completed" || source.error_text !== null || source.success === 0) return null;
  const deferrable = source.callable_kind === "dynamic"
    ? source.tool_name !== WORKBENCH_QUESTIONNAIRE_TOOL_NAME && rows.threadCallableDynamicContent.length > 0
    : (!isWorkbenchServer(source.server_name) || DEFERRABLE_WORKBENCH_TOOLS.has(source.tool_name))
      && rows.threadCallableMcpResultContent.length > 0;
  if (!deferrable) return null;
  const snapshot = {
    ...envelope.snapshot,
    deferredItemBodies: [{ itemId: root.id }],
    rows: { ...rows, threadCallableDynamicContent: [], threadCallableMcpResultContent: [] },
  };
  const value = { cursor: envelope.cursor, itemId: envelope.itemId, snapshot };
  return { ...value, retainedBytes: JSON.stringify(value).length * 2 };
}
