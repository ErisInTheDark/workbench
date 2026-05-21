/*
 * Exports:
 * - shouldRouteRawResponseToRequestJournal: keep full thread responses out of per-turn journals. Keywords: codex, transcript, journal routing.
 */
export function shouldRouteRawResponseToRequestJournal(method: string | null) {
  return method === "thread/read"
    || method === "thread/resume"
    || method === "thread/start"
    || method === "thread/fork";
}
