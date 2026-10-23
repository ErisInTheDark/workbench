/*
 * Exports:
 * - MAX_TRANSCRIPT_ITEM_STRING_CHARS: largest text one item field may carry into settlement.
 * - boundTranscriptItem: keep head and tail of any oversized string in an item, returning the same object when nothing exceeds the bound.
 * - boundTranscriptObservations: apply the item bound to item observations, including those nested in windows and turn scopes.
 */
import type { WorkbenchTranscriptAtomicObservation, WorkbenchTranscriptObservation } from "./workbench-transcript-types.ts";

/** One provider can return hundreds of megabytes in a tool result; every replay would push it through the writer again. */
export const MAX_TRANSCRIPT_ITEM_STRING_CHARS = 2 * 1024 * 1024;
const KEPT_EDGE_CHARS = MAX_TRANSCRIPT_ITEM_STRING_CHARS / 2;

function boundString(value: string) {
  // Inline images settle into the asset store; truncating one would corrupt it rather than shorten it.
  if (value.length <= MAX_TRANSCRIPT_ITEM_STRING_CHARS || value.startsWith("data:")) return value;
  const omitted = value.length - 2 * KEPT_EDGE_CHARS;
  return `${value.slice(0, KEPT_EDGE_CHARS)}\n[Workbench omitted ${omitted.toLocaleString("en-US")} characters to keep the thread responsive]\n${value.slice(-KEPT_EDGE_CHARS)}`;
}

export function boundTranscriptItem<Value>(value: Value): Value {
  if (typeof value === "string") return boundString(value) as Value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry: unknown) => {
      const bounded = boundTranscriptItem(entry);
      changed ||= bounded !== entry;
      return bounded;
    });
    return (changed ? next : value) as Value;
  }
  let next: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value)) {
    const bounded = boundTranscriptItem(entry);
    if (bounded !== entry) (next ??= { ...value as Record<string, unknown> })[key] = bounded;
  }
  return (next ?? value) as Value;
}

function boundAtomic<Observation extends WorkbenchTranscriptAtomicObservation>(observation: Observation): Observation {
  if (observation.kind !== "item") return observation;
  const item = boundTranscriptItem(observation.item);
  return item === observation.item ? observation : { ...observation, item };
}

function boundNested<Observation extends WorkbenchTranscriptAtomicObservation>(observations: readonly Observation[]) {
  let changed = false;
  const next = observations.map(observation => {
    const bounded = boundAtomic(observation);
    changed ||= bounded !== observation;
    return bounded;
  });
  return changed ? next : observations;
}

export function boundTranscriptObservations(observations: readonly WorkbenchTranscriptObservation[]): readonly WorkbenchTranscriptObservation[] {
  return observations.map((observation): WorkbenchTranscriptObservation => {
    switch (observation.kind) {
      case "item":
        return boundAtomic(observation);
      case "canonicalWindow":
      case "providerTurnScope": {
        const nested = boundNested(observation.observations);
        return nested === observation.observations ? observation : { ...observation, observations: nested };
      }
      default:
        return observation;
    }
  });
}
