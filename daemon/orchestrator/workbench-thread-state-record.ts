/*
 * Keywords: thread, internal record, title history, bounded projection, conformance.
 * Exports:
 * - WorkbenchThreadSnoozeTarget/WorkbenchThreadStateRecord/WorkbenchThreadStateEntry: internal UI-independent thread and dependent-snooze shapes. Keywords: thread, state, record, headless, snooze.
 * - parseWorkbenchThreadStateEntry/safeParseWorkbenchThreadStateEntry: validate persisted and mutated internal entries. Keywords: validation, persistence, migration.
 * - conformStoredWorkbenchThreadStateRecord: preserve valid durable facts while repairing an identified stored record to the current schema. Keywords: storage, conformance, defaults, compatibility.
 * - projectWorkbenchThreadStateEntry: derive the public sidebar projection from internal state. Keywords: sidebar, projection, boundary.
 */
import { z } from "zod";

import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { previousThreadTitles, WorkbenchThreadTitleHistoryEntrySchema, type WorkbenchThreadTitleHistoryEntry } from "workbench-shared/workbench/thread/thread-title-history";
import {
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchHarnessSchema,
  WorkbenchThreadSidebarEntrySchema,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";

type WorkbenchProviderSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
type WithoutProjections<TValue> = TValue extends unknown ? Omit<TValue, "waitingFor" | "previousTitles"> : never;
type WorkbenchProviderThreadEntry = WithoutProjections<WorkbenchProviderSidebarEntry>;

export type WorkbenchThreadStateRecord = WorkbenchProviderThreadEntry & {
  titleHistory?: WorkbenchThreadTitleHistoryEntry[];
  gitHistoryCleanedAt: number | null;
  mcpGeneration: string | null;
  profile: WorkbenchComposerProfileSelectionState | null;
  providerObserved: boolean;
  settledAt: number | null;
  snoozedUntil: WorkbenchThreadSnoozeTarget | null;
};

export type WorkbenchThreadStateEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> | WorkbenchThreadStateRecord;
export interface WorkbenchThreadSnoozeTarget {
  identity: {
    harness: "codex" | "copilot" | "opencode";
    threadId: string;
  };
  projectId: string;
}

export type StoredWorkbenchThreadStateRecordConformance =
  | { data: WorkbenchThreadStateRecord; repairedPaths: PropertyKey[][]; success: true }
  | { error: z.ZodError; success: false };

const ThreadIdentitySchema = z.object({
  harness: WorkbenchHarnessSchema,
  threadId: z.string().trim().min(1),
}).strip();
const WorkbenchThreadSnoozeTargetSchema = z.object({
  identity: ThreadIdentitySchema,
  projectId: z.string().trim().min(1),
}).strict();

const StoredRecordLocatorSchema = z.discriminatedUnion("entryKind", [
  z.object({
    entryKind: z.literal("thread"),
    identity: ThreadIdentitySchema,
  }).passthrough(),
  z.object({
    cwd: z.string().trim().min(1),
    entryKind: z.literal("subagent"),
    identity: ThreadIdentitySchema,
    parentThreadId: z.string().trim().min(1),
  }).passthrough(),
]);

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function defaultLifecycle(value: unknown): WorkbenchThreadLifecycle {
  const lifecycle = recordValue(value);
  if (lifecycle.kind === "working") {
    return { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false };
  }
  if (lifecycle.kind === "completed") {
    return { kind: "completed", reason: "userCompleted", settled: lifecycle.settled === true };
  }
  if (lifecycle.kind === "stopped") {
    return { kind: "stopped", reason: "userMarkedStopped", settled: lifecycle.settled === true };
  }
  return { kind: "needsAttention", reason: "noActiveTurn", settled: false };
}

function defaultThreadMetadata(value: unknown): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["metadata"] {
  const metadata = recordValue(value);
  return metadata.archived === true
    ? { archived: true, pinned: false, snoozed: false }
    : {
      archived: false,
      pinned: metadata.pinned === true,
      snoozed: metadata.snoozed === true,
    };
}

function storedRecordDefaults(
  locator: z.infer<typeof StoredRecordLocatorSchema>,
  candidate: Record<string, unknown>,
  projectId: string,
): WorkbenchProviderThreadEntry {
  const lifecycle = defaultLifecycle(candidate.lifecycle);
  const title = locator.identity.threadId;
  if (locator.entryKind === "thread") {
    return {
      activityAt: 0,
      entryKind: "thread",
      identity: locator.identity,
      lifecycle,
      metadata: defaultThreadMetadata(candidate.metadata),
      title,
    };
  }
  return {
    activityAt: 0,
    createdAt: 0,
    cwd: locator.cwd,
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: locator.identity,
    lifecycle,
    name: locator.identity.threadId,
    parentThreadId: locator.parentThreadId,
    pinned: false,
    profileId: "",
    profileName: "",
    projectId,
    title,
    updatedAt: 0,
  };
}

function internalFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { gitHistoryCleanedAt: null, mcpGeneration: null, profile: null, providerObserved: true, settledAt: null, snoozedUntil: null };
  }
  const record = value as Record<string, unknown>;
  const profile = WorkbenchComposerProfileSelectionSchema.safeParse(record.profile);
  const snoozedUntil = WorkbenchThreadSnoozeTargetSchema.safeParse(record.snoozedUntil);
  const titleHistory = z.array(WorkbenchThreadTitleHistoryEntrySchema).safeParse(record.titleHistory);
  return {
    ...(titleHistory.success ? { titleHistory: titleHistory.data } : {}),
    gitHistoryCleanedAt: typeof record.gitHistoryCleanedAt === "number" && Number.isFinite(record.gitHistoryCleanedAt) && record.gitHistoryCleanedAt >= 0
      ? Math.trunc(record.gitHistoryCleanedAt)
      : null,
    mcpGeneration: typeof record.mcpGeneration === "string" && record.mcpGeneration.trim()
      ? record.mcpGeneration.trim()
      : null,
    profile: profile.success ? profile.data : null,
    providerObserved: record.providerObserved !== false,
    settledAt: typeof record.settledAt === "number" && Number.isFinite(record.settledAt) && record.settledAt >= 0
      ? Math.trunc(record.settledAt)
      : null,
    snoozedUntil: snoozedUntil.success ? snoozedUntil.data : null,
  };
}

export function safeParseWorkbenchThreadStateEntry(value: unknown):
  | { data: WorkbenchThreadStateEntry; success: true }
  | { error: unknown; success: false } {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ titleHistory: _titleHistory, gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, profile: _profile, providerObserved: _providerObserved, settledAt: _settledAt, snoozedUntil: _snoozedUntil, waitingFor: _waitingFor, ...candidate }) => candidate)(value as Record<string, unknown>)
    : value;
  const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(publicCandidate);
  if (!parsed.success) return { error: parsed.error, success: false };
  if (parsed.data.entryKind === "draft") return { data: parsed.data, success: true };
  const { previousTitles: _previousTitles, waitingFor: _waitingFor, ...persistent } = parsed.data;
  return { data: { ...persistent, ...internalFields(value) }, success: true };
}

export function parseWorkbenchThreadStateEntry(value: unknown): WorkbenchThreadStateEntry {
  const parsed = safeParseWorkbenchThreadStateEntry(value);
  if ("error" in parsed) throw parsed.error;
  return parsed.data;
}

export function conformStoredWorkbenchThreadStateRecord(
  value: unknown,
  projectId: string,
): StoredWorkbenchThreadStateRecordConformance {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ titleHistory: _titleHistory, gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, profile: _profile, providerObserved: _providerObserved, settledAt: _settledAt, snoozedUntil: _snoozedUntil, waitingFor: _waitingFor, ...candidate }) => candidate)(value as Record<string, unknown>)
    : value;
  const locator = StoredRecordLocatorSchema.safeParse(publicCandidate);
  if (!locator.success) return { error: locator.error, success: false };
  const candidate = publicCandidate as Record<string, unknown>;
  const conformed = conformToZodSchema(
    WorkbenchThreadSidebarEntrySchema,
    publicCandidate,
    storedRecordDefaults(locator.data, candidate, projectId),
  );
  if (conformed.data.entryKind === "draft") {
    return { error: new z.ZodError([{ code: "custom", message: "A stored provider record cannot be a draft.", path: ["entryKind"] }]), success: false };
  }
  const { previousTitles: _previousTitles, waitingFor: _waitingFor, ...persistent } = conformed.data;
  return {
    data: { ...persistent, ...internalFields(value) },
    repairedPaths: conformed.repairedPaths,
    success: true,
  };
}

export function projectWorkbenchThreadStateEntry(entry: WorkbenchThreadStateEntry): WorkbenchThreadSidebarEntry | null {
  if (entry.entryKind === "draft") return entry;
  if (!entry.providerObserved) return null;
  const { titleHistory, gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, profile: _profile, providerObserved: _providerObserved, settledAt: _settledAt, snoozedUntil: _snoozedUntil, ...projected } = entry;
  return WorkbenchThreadSidebarEntrySchema.parse({ ...projected, previousTitles: previousThreadTitles(titleHistory ?? [], entry.title) });
}
