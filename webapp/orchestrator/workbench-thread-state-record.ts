/*
 * Exports:
 * - WorkbenchThreadStateRecord/WorkbenchThreadStateEntry: internal UI-independent thread-state shapes. Keywords: thread, state, record, headless.
 * - parseWorkbenchThreadStateEntry/safeParseWorkbenchThreadStateEntry: validate persisted and mutated internal entries. Keywords: validation, persistence, migration.
 * - conformStoredWorkbenchThreadStateRecord: preserve valid durable facts while repairing an identified stored record to the current schema. Keywords: storage, conformance, defaults, compatibility.
 * - projectWorkbenchThreadStateEntry: derive the public sidebar projection from internal state. Keywords: sidebar, projection, boundary.
 */
import { z } from "zod";

import { conformToZodSchema } from "../lib/workbench/zod-schema-conformer";
import {
  WorkbenchHarnessSchema,
  WorkbenchThreadSidebarEntrySchema,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadLifecycle,
} from "../lib/workbench/thread/thread-state";

type WorkbenchProviderThreadEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export type WorkbenchThreadStateRecord = WorkbenchProviderThreadEntry & {
  gitHistoryCleanedAt: number | null;
  mcpGeneration: string | null;
  providerObserved: boolean;
  settledAt: number | null;
};

export type WorkbenchThreadStateEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> | WorkbenchThreadStateRecord;

export type StoredWorkbenchThreadStateRecordConformance =
  | { data: WorkbenchThreadStateRecord; repairedPaths: PropertyKey[][]; success: true }
  | { error: z.ZodError; success: false };

const ThreadIdentitySchema = z.object({
  harness: WorkbenchHarnessSchema,
  threadId: z.string().trim().min(1),
}).strip();

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
    return { gitHistoryCleanedAt: null, mcpGeneration: null, providerObserved: true, settledAt: null };
  }
  const record = value as Record<string, unknown>;
  return {
    gitHistoryCleanedAt: typeof record.gitHistoryCleanedAt === "number" && Number.isFinite(record.gitHistoryCleanedAt) && record.gitHistoryCleanedAt >= 0
      ? Math.trunc(record.gitHistoryCleanedAt)
      : null,
    mcpGeneration: typeof record.mcpGeneration === "string" && record.mcpGeneration.trim()
      ? record.mcpGeneration.trim()
      : null,
    providerObserved: record.providerObserved !== false,
    settledAt: typeof record.settledAt === "number" && Number.isFinite(record.settledAt) && record.settledAt >= 0
      ? Math.trunc(record.settledAt)
      : null,
  };
}

export function safeParseWorkbenchThreadStateEntry(value: unknown):
  | { data: WorkbenchThreadStateEntry; success: true }
  | { error: unknown; success: false } {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, providerObserved: _providerObserved, settledAt: _settledAt, ...candidate }) => candidate)(value as Record<string, unknown>)
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

export function conformStoredWorkbenchThreadStateRecord(
  value: unknown,
  projectId: string,
): StoredWorkbenchThreadStateRecordConformance {
  const publicCandidate = value && typeof value === "object" && !Array.isArray(value)
    ? (({ gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, providerObserved: _providerObserved, settledAt: _settledAt, ...candidate }) => candidate)(value as Record<string, unknown>)
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
  return {
    data: { ...conformed.data, ...internalFields(value) },
    repairedPaths: conformed.repairedPaths,
    success: true,
  };
}

export function projectWorkbenchThreadStateEntry(entry: WorkbenchThreadStateEntry): WorkbenchThreadSidebarEntry | null {
  if (entry.entryKind === "draft") return entry;
  if (!entry.providerObserved) return null;
  const { gitHistoryCleanedAt: _gitHistoryCleanedAt, mcpGeneration: _mcpGeneration, providerObserved: _providerObserved, settledAt: _settledAt, ...projected } = entry;
  return WorkbenchThreadSidebarEntrySchema.parse(projected);
}
