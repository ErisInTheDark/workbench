/*
 * Exports:
 * - WorkbenchThreadStateRecord/WorkbenchThreadStateEntry: internal UI-independent thread-state shapes. Keywords: thread, state, record, headless.
 * - parseWorkbenchThreadStateEntry/safeParseWorkbenchThreadStateEntry: validate persisted and mutated internal entries. Keywords: validation, persistence, migration.
 * - projectWorkbenchThreadStateEntry: derive the public sidebar projection from internal state. Keywords: sidebar, projection, boundary.
 */
import {
  WorkbenchThreadSidebarEntrySchema,
  type WorkbenchThreadSidebarEntry,
} from "../lib/workbench/thread/thread-state";

type WorkbenchProviderThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export type WorkbenchThreadStateRecord = WorkbenchProviderThreadEntry & {
  mcpGeneration: string | null;
  providerObserved: boolean;
};

export type WorkbenchThreadStateEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> | WorkbenchThreadStateRecord;

function internalFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mcpGeneration: null, providerObserved: true };
  }
  const record = value as Record<string, unknown>;
  return {
    mcpGeneration: typeof record.mcpGeneration === "string" && record.mcpGeneration.trim()
      ? record.mcpGeneration.trim()
      : null,
    providerObserved: record.providerObserved !== false,
  };
}

export function safeParseWorkbenchThreadStateEntry(value: unknown):
  | { data: WorkbenchThreadStateEntry; success: true }
  | { error: unknown; success: false } {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ mcpGeneration: _mcpGeneration, providerObserved: _providerObserved, ...candidate }) => candidate)(value as Record<string, unknown>)
    : value;
  const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(publicCandidate);
  if (!parsed.success) return { error: parsed.error, success: false };
  if (parsed.data.entryKind === "draft") return { data: parsed.data, success: true };
  return { data: { ...parsed.data, ...internalFields(value) }, success: true };
}

export function parseWorkbenchThreadStateEntry(value: unknown): WorkbenchThreadStateEntry {
  const parsed = safeParseWorkbenchThreadStateEntry(value);
  if ("error" in parsed) throw parsed.error;
  return parsed.data;
}

export function projectWorkbenchThreadStateEntry(entry: WorkbenchThreadStateEntry): WorkbenchThreadSidebarEntry | null {
  if (entry.entryKind === "draft") return entry;
  if (!entry.providerObserved) return null;
  const { mcpGeneration: _mcpGeneration, providerObserved: _providerObserved, ...projected } = entry;
  return WorkbenchThreadSidebarEntrySchema.parse(projected);
}
