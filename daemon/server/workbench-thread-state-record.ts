/*
 * Exports:
 * - WorkbenchThreadSnoozeTarget/WorkbenchThreadStateRecord/WorkbenchThreadStateEntry: internal thread and dependent-snooze shapes.
 * - StoredWorkbenchThreadStateRecordConformance: repaired record or validation failure.
 * - parseWorkbenchThreadStateEntry/safeParseWorkbenchThreadStateEntry: validate persisted and mutated entries.
 * - conformStoredWorkbenchThreadStateRecord: repair a stored record while preserving valid facts.
 * - projectWorkbenchThreadStateEntry: derive the public sidebar projection.
 */
import { z } from "zod";
import type { WorkbenchHarness } from "workbench-shared/types";
import { ProjectIdSchema, WorkbenchThreadIdSchema, type ProjectId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";

import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { currentThreadTitleName, previousThreadTitles, WorkbenchThreadTitleHistoryEntrySchema, type WorkbenchThreadTitleHistoryEntry } from "workbench-shared/workbench/thread/thread-title-history";
import {
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchHarnessSchema,
  WorkbenchThreadSidebarEntrySchema,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";

type WorkbenchProviderSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
type WithoutProjections<TValue> = TValue extends unknown ? Omit<TValue, "waitingFor" | "waitingOnThreads" | "previousTitles"> : never;
type WorkbenchProviderThreadEntry = WithoutProjections<WorkbenchProviderSidebarEntry>;

export type WorkbenchThreadStateRecord = WorkbenchProviderThreadEntry & {
  titleHistory?: WorkbenchThreadTitleHistoryEntry[];
  gitHistoryCleanedAt: number | null;
  mcpGeneration: string | null;
  profile: WorkbenchComposerProfileSelectionState | null;
  providerObserved: boolean;
  settledAt: number | null;
  snoozedUntil: { targets: WorkbenchThreadSnoozeTarget[] } | null;
};

export type WorkbenchThreadStateEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> | WorkbenchThreadStateRecord;
export interface WorkbenchThreadSnoozeTarget {
  identity: {
    harness: WorkbenchHarness;
    threadId: WorkbenchThreadId;
  };
  projectId: ProjectId;
  title: string;
}

export type StoredWorkbenchThreadStateRecordConformance =
  | { data: WorkbenchThreadStateRecord; repairedPaths: PropertyKey[][]; success: true }
  | { error: z.ZodError; success: false };

const ThreadIdentitySchema = z.object({
  harness: WorkbenchHarnessSchema,
  threadId: WorkbenchThreadIdSchema,
}).strip();
const WorkbenchThreadSnoozeTargetSchema = z.object({
  identity: ThreadIdentitySchema,
  projectId: ProjectIdSchema,
  title: z.string(),
}).strict();

function dependentSnooze(value: Record<string, unknown>): { targets: WorkbenchThreadSnoozeTarget[] } | null {
  const stored = recordValue(value.snoozedUntil);
  const candidates = Array.isArray(stored.targets) ? stored.targets
    : value.snoozedUntil ? [value.snoozedUntil] : [];
  const targets = new Map<string, WorkbenchThreadSnoozeTarget>();
  for (const candidate of candidates) {
    const raw = recordValue(candidate);
    const identity = recordValue(raw.identity);
    const parsed = WorkbenchThreadSnoozeTargetSchema.safeParse({
      ...raw, title: raw.title ?? identity.threadId,
    });
    if (!parsed.success) continue;
    const target = parsed.data;
    targets.set(`${target.projectId}\0${target.identity.harness}\0${target.identity.threadId}`, target);
  }
  return targets.size ? { targets: [...targets.values()] } : null;
}

const StoredRecordLocatorSchema = z.discriminatedUnion("entryKind", [
  z.object({
    entryKind: z.literal("thread"),
    identity: ThreadIdentitySchema,
  }).passthrough(),
  z.object({
    cwd: z.string().trim().min(1),
    entryKind: z.literal("subagent"),
    identity: ThreadIdentitySchema,
    parentThreadId: WorkbenchThreadIdSchema,
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
  projectId: ProjectId,
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
    snoozedUntil: dependentSnooze(record),
  };
}

function repairWorkingSnooze(record: WorkbenchThreadStateRecord): WorkbenchThreadStateRecord {
  if (record.entryKind !== "thread" || record.lifecycle.kind !== "working" || !record.metadata.snoozed) return record;
  return {
    ...record,
    metadata: { archived: false, pinned: record.metadata.pinned, snoozed: false },
    snoozedUntil: null,
  };
}

export function safeParseWorkbenchThreadStateEntry(value: unknown):
  | { data: WorkbenchThreadStateEntry; success: true }
  | { error: unknown; success: false } {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ titleHistory: _titleHistory, gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, profile: _profile, providerObserved: _providerObserved, settledAt: _settledAt, snoozedUntil: _snoozedUntil, waitingFor: _waitingFor, waitingOnThreads: _waitingOnThreads, ...candidate }) => candidate)(value as Record<string, unknown>)
    : value;
  const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(publicCandidate);
  if (!parsed.success) return { error: parsed.error, success: false };
  if (parsed.data.entryKind === "draft") return { data: parsed.data, success: true };
  if (parsed.data.entryKind === "thread") {
    const { previousTitles: _previousTitles, waitingFor: _waitingFor, waitingOnThreads: _waitingOnThreads, ...persistent } = parsed.data;
    return { data: repairWorkingSnooze({ ...persistent, ...internalFields(value) }), success: true };
  }
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
  projectId: ProjectId,
): StoredWorkbenchThreadStateRecordConformance {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ titleHistory: _titleHistory, gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, profile: _profile, providerObserved: _providerObserved, settledAt: _settledAt, snoozedUntil: _snoozedUntil, waitingFor: _waitingFor, waitingOnThreads: _waitingOnThreads, ...candidate }) => candidate)(value as Record<string, unknown>)
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
  const persistent = conformed.data.entryKind === "thread"
    ? (({ previousTitles: _previousTitles, waitingFor: _waitingFor, waitingOnThreads: _waitingOnThreads, ...record }) => record)(conformed.data)
    : (({ previousTitles: _previousTitles, waitingFor: _waitingFor, ...record }) => record)(conformed.data);
  // A running acceptance belongs to the daemon process that ran it; a stored one is a crash leftover.
  const gitArc = persistent.gitArc?.acceptance
    ? (({ acceptance: _acceptance, ...arc }) => arc)(persistent.gitArc)
    : persistent.gitArc;
  const record = { ...persistent, ...(gitArc !== undefined ? { gitArc } : {}), ...internalFields(value) };
  const repaired = repairWorkingSnooze(record);
  const repairedWorkingSnooze = repaired !== record;
  return {
    data: repaired,
    repairedPaths: [
      ...conformed.repairedPaths,
      ...(repairedWorkingSnooze
        ? [["metadata", "snoozed"], ...(record.snoozedUntil ? [["snoozedUntil"]] : [])]
        : []),
    ],
    success: true,
  };
}

export function projectWorkbenchThreadStateEntry(entry: WorkbenchThreadStateEntry): WorkbenchThreadSidebarEntry | null {
  if (entry.entryKind === "draft") return entry;
  // Provider omission cannot hide Workbench-owned top-level records.
  if (entry.entryKind === "subagent" && !entry.providerObserved) return null;
  const { titleHistory, gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, profile: _profile, providerObserved: _providerObserved, settledAt: _settledAt, snoozedUntil, ...projected } = entry;
  // The recorded explicit title owns display; the stored title is only the provider display label.
  const displayTitle = currentThreadTitleName(titleHistory ?? []) ?? entry.title;
  return WorkbenchThreadSidebarEntrySchema.parse({
    ...projected, title: displayTitle, ...(entry.profile ? { profile: entry.profile } : {}),
    previousTitles: previousThreadTitles(titleHistory ?? [], displayTitle),
    ...(entry.entryKind === "thread" ? { waitingOnThreads: snoozedUntil?.targets ?? [] } : {}),
  });
}
