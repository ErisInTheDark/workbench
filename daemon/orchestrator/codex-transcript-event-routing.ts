/*
 * Exports:
 * - shouldRouteRawResponseToRequestJournal: route full thread responses to bounded request journals.
 * - shouldRecordDurableTranscriptNotification: separate durable transcript facts from live updates.
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
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "turn/diff/updated":
      return false;
    default:
      return true;
  }
}
