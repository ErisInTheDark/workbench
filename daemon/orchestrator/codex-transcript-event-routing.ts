/*
 * Exports:
 * - shouldRouteRawResponseToRequestJournal: route full thread session responses to bounded request journals instead of per-turn journals. Keywords: codex, transcript, journal routing.
 * - shouldRecordDurableTranscriptNotification: separate durable transcript facts from provider-live presentation updates. Keywords: codex, transcript, storage, delta, live.
 */
export function shouldRouteRawResponseToRequestJournal(method: string | null) {
  return method === "thread/read"
    || method === "thread/resume"
    || method === "thread/start"
    || method === "thread/fork";
}

export function shouldRecordDurableTranscriptNotification(method: string | null) {
  switch (method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "turn/diff/updated":
    case "turn/plan/updated":
      return false;
    default:
      return true;
  }
}
