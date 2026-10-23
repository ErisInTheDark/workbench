/*
 * Exports:
 * - TRANSCRIPT_REASONING_PREVIEW_CHARS: how much of each settled reasoning section ships before it is opened.
 * - deferWorkbenchTranscriptEnvelopeBody: slim a settled item's envelope to what its collapsed row reads (tool output
 *   rows left out, reasoning sections cut to previews), or null when the body must stay eager.
 */
import type {
  WorkbenchTranscriptItemEnvelope, WorkbenchTranscriptSnapshot,
} from "../database/transcript/workbench-transcript-contract.ts";
import { WORKBENCH_QUESTIONNAIRE_TOOL_NAME } from "../thread/thread-questionnaire-history.ts";

type Rows = WorkbenchTranscriptSnapshot["rows"];

/** Enough for a collapsed row's title line; open-weight models write reasoning orders of magnitude longer. */
export const TRANSCRIPT_REASONING_PREVIEW_CHARS = 240;
/** Marks a cut preview; also keeps a step with a cut title openable, since its row opens only onto a body. */
const PREVIEW_ELLIPSIS = "\n…";

/**
 * Workbench MCP tools whose collapsed cards derive from arguments or structured results only.
 * Every other wb tool reads its human output while collapsed (titles, waits, git arc, browse rows).
 */
const DEFERRABLE_WORKBENCH_TOOLS = new Set(["shell", "rg"]);

function isWorkbenchServer(server: string | null) {
  return server === "wb" || server === "wbex";
}

function slimToolRows(rows: Rows): Rows | null {
  const source = rows.threadOperationCallableToolSources[0];
  if (!source || source.state !== "completed" || source.error_text !== null || source.success === 0) return null;
  const deferrable = source.callable_kind === "dynamic"
    ? source.tool_name !== WORKBENCH_QUESTIONNAIRE_TOOL_NAME && rows.threadCallableDynamicContent.length > 0
    : (!isWorkbenchServer(source.server_name) || DEFERRABLE_WORKBENCH_TOOLS.has(source.tool_name))
      && rows.threadCallableMcpResultContent.length > 0;
  return deferrable ? { ...rows, threadCallableDynamicContent: [], threadCallableMcpResultContent: [] } : null;
}

/** Streaming reasoning, and reasoning in a turn still running, stay whole: the live status line reads their newest text. */
function slimReasoningRows(rows: Rows, turnState: string | undefined): Rows | null {
  const reasoning = rows.threadItemReasoning[0];
  if (!reasoning || reasoning.state === "streaming" || turnState === "admitted" || turnState === "inProgress") return null;
  if (!rows.threadReasoningSections.some(section => section.text.length > TRANSCRIPT_REASONING_PREVIEW_CHARS)) return null;
  return {
    ...rows,
    threadReasoningSections: rows.threadReasoningSections.map(section => section.text.length > TRANSCRIPT_REASONING_PREVIEW_CHARS
      ? { ...section, text: section.text.slice(0, TRANSCRIPT_REASONING_PREVIEW_CHARS).trimEnd() + PREVIEW_ELLIPSIS }
      : section),
  };
}

export function deferWorkbenchTranscriptEnvelopeBody(
  envelope: WorkbenchTranscriptItemEnvelope,
): WorkbenchTranscriptItemEnvelope | null {
  const { rows } = envelope.snapshot;
  const root = rows.threadItems[0];
  if (!root) return null;
  const slim = root.type === "reasoning"
    ? slimReasoningRows(rows, envelope.snapshot.turns[0]?.state)
    : slimToolRows(rows);
  if (!slim) return null;
  const snapshot = { ...envelope.snapshot, deferredItemBodies: [{ itemId: root.id }], rows: slim };
  const value = { cursor: envelope.cursor, itemId: envelope.itemId, snapshot };
  return { ...value, retainedBytes: JSON.stringify(value).length * 2 };
}
