/*
 * Exports:
 * - shouldRouteRawResponseToRequestJournal: keep full thread responses out of per-turn journals. Keywords: codex, transcript, journal routing.
 * - shouldPersistRawNotificationToJournal: skip high-volume streaming notifications that compact sidecars already capture. Keywords: codex, transcript, storage, delta.
 */
export function shouldRouteRawResponseToRequestJournal(method: string | null) {
  return method === "thread/read"
    || method === "thread/resume"
    || method === "thread/start"
    || method === "thread/fork";
}

export function shouldPersistRawNotificationToJournal(method: string | null) {
  switch (method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return false;
    default:
      return true;
  }
}
