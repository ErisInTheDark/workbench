/*
 * SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX: old display prefix retained only for compatibility aliases. Keywords: legacy, questionnaire, alias.
 * WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX/isWorkbenchMcpQuestionnaireRequestKey: identify Workbench-owned native questionnaire waits. Keywords: questionnaire, MCP, native, identity.
 * resolveQuestionnaireHistoryItemId: resolve the permanent item identity for one settled questionnaire. Keywords: questionnaire, identity, item.
 * mergeQuestionnaireHistoryEntries: merge settled questionnaire history by permanent item identity. Keywords: questionnaire, identity, collection, merge.
 */
import type { WorkbenchQuestionnaireHistoryEntry } from "../../types.ts";

export const SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX = "workbench:questionnaire-history:";
export const WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX = "workbench-mcp:";

export function isWorkbenchMcpQuestionnaireRequestKey(requestKey: string) {
  return requestKey.startsWith(WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX);
}

type QuestionnaireHistoryIdentity = Pick<
  WorkbenchQuestionnaireHistoryEntry,
  "requestKey" | "threadId" | "turnId"
> & {
  readonly itemId?: string | null;
};

export function resolveQuestionnaireHistoryItemId(
  entry: QuestionnaireHistoryIdentity,
) {
  return entry.itemId
    ?? `workbench-questionnaire:${entry.threadId}:${entry.turnId}:${entry.requestKey}`;
}

export function mergeQuestionnaireHistoryEntries<Entry extends QuestionnaireHistoryIdentity>(
  current: readonly Entry[],
  incoming: readonly Entry[],
) {
  const merged = [...current];
  const indexByItemId = new Map(merged.map((entry, index) => [
    resolveQuestionnaireHistoryItemId(entry),
    index,
  ]));

  for (const entry of incoming) {
    const itemId = resolveQuestionnaireHistoryItemId(entry);
    const existingIndex = indexByItemId.get(itemId);
    if (existingIndex === undefined) {
      indexByItemId.set(itemId, merged.length);
      merged.push(entry);
      continue;
    }

    merged[existingIndex] = entry;
  }

  return merged;
}

