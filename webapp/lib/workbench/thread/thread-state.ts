/*
 * Exports:
 * - WorkbenchThreadTargetSchema/WorkbenchThreadTarget: canonical blank, draft, provider, and parent-owned subagent identity. Keywords: route, draft, provider, subagent.
 * - WorkbenchThreadDraftSchema/WorkbenchThreadLifecycleSchema/WorkbenchThreadSidebarEntrySchema: strict wire and storage contracts. Keywords: zod, lifecycle, sidebar.
 * - WorkbenchThreadSidebarSnapshotSchema/WorkbenchThreadActivityUpdateSchema: full sidebar state and tiny activity delta contracts. Keywords: sidebar, websocket, revision.
 * - WorkbenchThreadStateOpenResultSchema/WorkbenchThreadStateOpenResult: atomic catalog, tree, and sidebar observation bootstrap. Keywords: open, bootstrap, snapshot.
 * - WorkbenchThreadStateSnapshotSchema/WorkbenchThreadStateRequestSchema: multiplexed sidebar, activity, project, and request protocol. Keywords: orchestrator, websocket, revision.
 * - getThreadSidebarGroup/sortThreadSidebarEntries: exhaustive visible grouping and stable activity ordering. Keywords: grouping, pin, sort.
 * - normalizeWorkbenchActivityTimestampMs: normalize provider second/millisecond timestamps at the sidebar boundary. Keywords: timestamp, provider, normalization.
 * - resolveWorkbenchThreadTitle: choose a meaningful provider name, first-message preview, or neutral fallback. Keywords: title, preview, uuid.
 * - isWorkbenchThreadStatusProviderOwned/reduceWorkbenchThreadLifecycle/projectWorkbenchThreadSidebarEntries: manual-status eligibility, exact-turn transitions, and direct-child status projection. Keywords: working, attention, completed, stopped, parent.
 * - countDraftPromptTokens/createDraftTitle: durable draft materialization and title rules. Keywords: draft, threshold, title.
 */

import { z } from "zod";

import { WorkbenchProjectsPayloadSchema, WorkbenchProjectStateUpdateSchema } from "../project/project-state";

export const WorkbenchHarnessSchema = z.enum(["codex", "copilot", "opencode"]);
export type WorkbenchHarnessId = z.infer<typeof WorkbenchHarnessSchema>;

type JsonPrimitive = null | boolean | number | string;
interface JsonArray extends Array<JsonValue> {}
interface JsonObject { [key: string]: JsonValue }
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

const CanonicalUuidSchema = z.uuid();
const ThreadIdentitySchema = z.object({
  harness: WorkbenchHarnessSchema,
  threadId: z.string().trim().min(1),
}).strict();

export const WorkbenchThreadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ draftId: CanonicalUuidSchema, kind: z.literal("draft") }).strict(),
  z.object({ harness: WorkbenchHarnessSchema.optional(), kind: z.literal("provider"), threadId: z.string().trim().min(1) }).strict(),
  z.object({ harness: WorkbenchHarnessSchema.optional(), kind: z.literal("subagent"), parentThreadId: z.string().trim().min(1), threadId: z.string().trim().min(1) }).strict(),
]);
export type WorkbenchThreadTarget = z.infer<typeof WorkbenchThreadTargetSchema>;

export const WorkbenchThreadDraftSchema = z.object({
  agent: z.string().nullable(),
  attachments: z.array(JsonValueSchema),
  clientUpdatedAt: z.number().int().nonnegative(),
  composerSettings: z.record(z.string(), JsonValueSchema),
  createdAt: z.number().int().nonnegative(),
  draftId: CanonicalUuidSchema,
  harness: WorkbenchHarnessSchema,
  model: z.string().nullable(),
  profileId: z.string().nullable(),
  projectId: z.string().trim().min(1),
  prompt: z.string(),
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type WorkbenchThreadDraft = z.infer<typeof WorkbenchThreadDraftSchema>;

const AgentTurnSchema = z.object({
  agentStatus: z.enum(["working", "completed", "blocked"]),
  turnId: z.string().trim().min(1),
}).strict();

const WorkingLifecycleSchema = z.object({
  agent: z.object({ agentStatus: z.literal("working"), turnId: z.string().trim().min(1).optional() }).strict(),
  kind: z.literal("working"),
  reason: z.literal("acceptedIntent"),
  settled: z.literal(false),
}).strict();

const CanonicalNeedsAttentionLifecycleSchema = z.discriminatedUnion("reason", [
  z.object({ kind: z.literal("needsAttention"), reason: z.literal("pendingInput"), requestKey: z.string().min(1), settled: z.literal(false), turnId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("needsAttention"), reason: z.literal("noActiveTurn"), settled: z.literal(false) }).strict(),
]);

const LegacyNeedsAttentionLifecycleSchema = z.discriminatedUnion("reason", [
  z.object({ agent: AgentTurnSchema.extend({ agentStatus: z.literal("blocked") }), kind: z.literal("needsAttention"), reason: z.literal("agentBlocked"), settled: z.literal(false) }).strict(),
  z.object({ agent: AgentTurnSchema, kind: z.literal("needsAttention"), reason: z.literal("turnEnded"), settled: z.literal(false) }).strict(),
  z.object({ kind: z.literal("needsAttention"), reason: z.literal("restartRecoveryFailed"), settled: z.literal(false) }).strict(),
  z.object({ kind: z.literal("needsAttention"), reason: z.literal("providerSystemError"), settled: z.literal(false) }).strict(),
]);

const CompletedLifecycleSchema = z.discriminatedUnion("reason", [
  z.object({ agent: AgentTurnSchema.extend({ agentStatus: z.literal("completed") }), kind: z.literal("completed"), reason: z.literal("agentCompleted"), settled: z.boolean() }).strict(),
  z.object({ agent: AgentTurnSchema.optional(), kind: z.literal("completed"), reason: z.literal("userCompleted"), settled: z.boolean() }).strict(),
  z.object({ kind: z.literal("completed"), reason: z.literal("providerInactive"), settled: z.boolean() }).strict(),
]);

const StoppedLifecycleSchema = z.discriminatedUnion("reason", [
  z.object({ kind: z.literal("stopped"), reason: z.literal("providerInterrupted"), settled: z.boolean(), turnId: z.string().min(1) }).strict(),
  z.object({ agent: AgentTurnSchema.optional(), kind: z.literal("stopped"), reason: z.literal("userMarkedStopped"), settled: z.boolean() }).strict(),
]);

export const WorkbenchThreadLifecycleSchema = z.union([
  WorkingLifecycleSchema,
  CanonicalNeedsAttentionLifecycleSchema,
  LegacyNeedsAttentionLifecycleSchema,
  CompletedLifecycleSchema,
  StoppedLifecycleSchema,
]).transform((lifecycle) => lifecycle.kind === "needsAttention"
  && lifecycle.reason !== "pendingInput"
  && lifecycle.reason !== "noActiveTurn"
  ? { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const }
  : lifecycle);
export type WorkbenchThreadLifecycle = z.infer<typeof WorkbenchThreadLifecycleSchema>;

export const WorkbenchGitArcFileClaimSchema = z.object({
  checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  claimedPaths: z.array(z.string().min(1)).min(1),
  intentDescription: z.string(),
  intentName: z.string().min(1),
  proposalId: z.string().min(1).nullable(),
  proposalStatus: z.enum(["committed", "proposed", "superseded", "unavailable"]).nullable().optional(),
  updatedAt: z.string().min(1),
}).strict();
export type WorkbenchGitArcFileClaim = z.infer<typeof WorkbenchGitArcFileClaimSchema>;

const VisibleMetadataSchema = z.object({ archived: z.literal(false), pinned: z.boolean(), snoozed: z.boolean() }).strict();
const ArchivedMetadataSchema = z.object({ archived: z.literal(true), pinned: z.literal(false), snoozed: z.literal(false) }).strict();
const TopLevelMetadataSchema = z.union([VisibleMetadataSchema, ArchivedMetadataSchema]);

const SidebarCommonSchema = z.object({ activityAt: z.number().int().nonnegative(), title: z.string() }).strict();
const DraftEntrySchema = SidebarCommonSchema.extend({
  draft: WorkbenchThreadDraftSchema,
  entryKind: z.literal("draft"),
  metadata: VisibleMetadataSchema,
}).strict();
const TopLevelEntrySchema = SidebarCommonSchema.extend({
  entryKind: z.literal("thread"),
  fileClaim: WorkbenchGitArcFileClaimSchema.nullable().optional(),
  identity: ThreadIdentitySchema,
  lifecycle: WorkbenchThreadLifecycleSchema,
  metadata: TopLevelMetadataSchema,
}).strict();
const SubagentEntrySchema = SidebarCommonSchema.extend({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().min(1),
  directSubagentIndex: z.number().int().nonnegative(),
  entryKind: z.literal("subagent"),
  fileClaim: WorkbenchGitArcFileClaimSchema.nullable().optional(),
  identity: ThreadIdentitySchema,
  lifecycle: WorkbenchThreadLifecycleSchema,
  name: z.string().trim().min(1),
  parentThreadId: z.string().trim().min(1),
  pinned: z.boolean(),
  profileId: z.string(),
  profileName: z.string(),
  projectId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.lifecycle.settled && value.pinned) context.addIssue({ code: "custom", message: "Settled subagents cannot remain locked." });
});

export const WorkbenchThreadSidebarEntrySchema = z.discriminatedUnion("entryKind", [DraftEntrySchema, TopLevelEntrySchema, SubagentEntrySchema]);
export type WorkbenchThreadSidebarEntry = z.infer<typeof WorkbenchThreadSidebarEntrySchema>;
export type WorkbenchTopLevelThreadSidebarEntry = z.infer<typeof TopLevelEntrySchema>;

export const WorkbenchThreadSidebarSnapshotSchema = z.object({
  entries: z.array(WorkbenchThreadSidebarEntrySchema),
  error: z.string().max(500).nullable(),
  freshness: z.enum(["loading", "fresh", "partial"]),
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
}).strict();
export type WorkbenchThreadSidebarSnapshot = z.infer<typeof WorkbenchThreadSidebarSnapshotSchema>;

export const WorkbenchThreadStateOpenResultSchema = z.object({
  catalog: WorkbenchProjectsPayloadSchema,
  project: WorkbenchProjectStateUpdateSchema.nullable(),
  sidebar: WorkbenchThreadSidebarSnapshotSchema,
}).strict();
export type WorkbenchThreadStateOpenResult = z.infer<typeof WorkbenchThreadStateOpenResultSchema>;

export const WorkbenchThreadActivityUpdateSchema = z.object({
  activityAt: z.number().int().nonnegative(),
  identity: ThreadIdentitySchema,
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  updateKind: z.literal("activity"),
}).strict();
export type WorkbenchThreadActivityUpdate = z.infer<typeof WorkbenchThreadActivityUpdateSchema>;

export const WorkbenchThreadStateSnapshotSchema = z.union([
  WorkbenchThreadSidebarSnapshotSchema,
  WorkbenchThreadActivityUpdateSchema,
  WorkbenchProjectStateUpdateSchema,
]);
export type WorkbenchThreadStateSnapshot = z.infer<typeof WorkbenchThreadStateSnapshotSchema>;

const ProjectRequestBase = z.object({ projectId: z.string().trim().min(1) }).strict();
export const WorkbenchThreadStateRequestSchema = z.discriminatedUnion("method", [
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/open"), version: z.literal(2).optional() }),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/close") }),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/refresh") }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema.optional(), identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/intent/accept"), title: z.string().trim().min(1), turnId: z.string().trim().min(1) }),
  ProjectRequestBase.extend({ draft: WorkbenchThreadDraftSchema, method: z.literal("workbench/thread-state/draft/upsert") }),
  ProjectRequestBase.extend({ clientUpdatedAt: z.number().int().nonnegative(), draftId: CanonicalUuidSchema, method: z.literal("workbench/thread-state/draft/delete") }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema, method: z.literal("workbench/thread-state/draft/pin/set"), pinned: z.boolean() }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema, method: z.literal("workbench/thread-state/draft/snooze/set"), snoozed: z.boolean() }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/pin/set"), pinned: z.boolean() }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/snooze/set"), snoozed: z.boolean() }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/settle") }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/restore") }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/status/set"), status: z.enum(["needsAttention", "completed", "stopped"]) }),
  ProjectRequestBase.extend({ archived: z.boolean(), identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/archive/set") }),
]);
export type WorkbenchThreadStateRequest = z.infer<typeof WorkbenchThreadStateRequestSchema>;

export type WorkbenchThreadSidebarGroup = "drafts" | "needsAttention" | "completed" | "working" | "snoozed" | "other" | "hidden";

export function normalizeWorkbenchActivityTimestampMs(timestamp: number) {
  return Math.trunc(timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp);
}

const UUID_TITLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_THREAD_TITLE_PATTERN = /^new thread$/iu;

function normalizeThreadTitleCandidate(value: string | null | undefined, maxLength = 80) {
  const firstLine = value?.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  const title = firstLine.replace(/\s+/gu, " ");
  return title.length <= maxLength ? title : `${title.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function resolveWorkbenchThreadTitle({
  fallback = "New thread",
  id,
  name,
  preview,
}: {
  fallback?: string;
  id: string;
  name: string | null | undefined;
  preview: string | null | undefined;
}) {
  const normalizedId = id.trim();
  const normalizedName = normalizeThreadTitleCandidate(name);
  if (normalizedName && normalizedName !== normalizedId && !UUID_TITLE_PATTERN.test(normalizedName) && !DEFAULT_THREAD_TITLE_PATTERN.test(normalizedName)) {
    return normalizedName;
  }
  const normalizedPreview = normalizeThreadTitleCandidate(preview);
  return normalizedPreview && normalizedPreview !== normalizedId ? normalizedPreview : fallback;
}

export function getThreadSidebarGroup(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadSidebarGroup {
  if (entry.entryKind !== "subagent" && entry.metadata.archived) return "hidden";
  if (entry.entryKind !== "subagent" && entry.metadata.snoozed) return "snoozed";
  if (entry.entryKind === "draft") return "drafts";
  if (entry.lifecycle.kind === "needsAttention") return "needsAttention";
  if ((entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped") && !entry.lifecycle.settled) return "completed";
  if (entry.lifecycle.kind === "working") return "working";
  return "other";
}

export function sortThreadSidebarEntries(entries: readonly WorkbenchThreadSidebarEntry[]) {
  return [...entries].sort((left, right) => {
    const leftPinned = left.entryKind === "subagent" ? left.pinned : left.metadata.pinned;
    const rightPinned = right.entryKind === "subagent" ? right.pinned : right.metadata.pinned;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (left.activityAt !== right.activityAt) return right.activityAt - left.activityAt;
    const leftHarness = left.entryKind === "draft" ? left.draft.harness : left.identity.harness;
    const rightHarness = right.entryKind === "draft" ? right.draft.harness : right.identity.harness;
    const harnessOrder = leftHarness.localeCompare(rightHarness);
    if (harnessOrder) return harnessOrder;
    const leftId = left.entryKind === "draft" ? left.draft.draftId : left.identity.threadId;
    const rightId = right.entryKind === "draft" ? right.draft.draftId : right.identity.threadId;
    return leftId.localeCompare(rightId);
  });
}

export type WorkbenchLifecycleEvent =
  | { kind: "acceptedIntent"; turnId: string }
  | { kind: "pendingInput"; requestKey: string; turnId: string }
  | { kind: "inputResolved"; requestKey: string; turnId: string }
  | { kind: "agentStatus"; status: "completed" | "blocked"; turnId: string }
  | { kind: "turnCompleted"; status: "completed" | "interrupted" | "failed"; turnId: string }
  | { kind: "recoveryFailed" }
  | { kind: "providerSystemError" }
  | { kind: "userNeedsAttention" }
  | { kind: "userCompleted" }
  | { kind: "userStopped" }
  | { kind: "settle" }
  | { kind: "restore" };

export function getWorkbenchLifecycleTurnId(lifecycle: WorkbenchThreadLifecycle | null) {
  if (!lifecycle) return null;
  if ("turnId" in lifecycle && typeof lifecycle.turnId === "string") return lifecycle.turnId;
  return "agent" in lifecycle && lifecycle.agent ? lifecycle.agent.turnId ?? null : null;
}

export function isWorkbenchThreadStatusProviderOwned(lifecycle: WorkbenchThreadLifecycle) {
  return lifecycle.kind === "working" || (lifecycle.kind === "needsAttention" && lifecycle.reason === "pendingInput");
}

export function reduceWorkbenchThreadLifecycle(current: WorkbenchThreadLifecycle | null, event: WorkbenchLifecycleEvent): WorkbenchThreadLifecycle {
  const currentTurnId = getWorkbenchLifecycleTurnId(current);
  switch (event.kind) {
    case "acceptedIntent":
      return { agent: { agentStatus: "working", turnId: event.turnId }, kind: "working", reason: "acceptedIntent", settled: false };
    case "pendingInput":
      if (currentTurnId && currentTurnId !== event.turnId) return current!;
      return { kind: "needsAttention", reason: "pendingInput", requestKey: event.requestKey, settled: false, turnId: event.turnId };
    case "inputResolved":
      if (current?.kind !== "needsAttention" || current.reason !== "pendingInput" || current.requestKey !== event.requestKey || current.turnId !== event.turnId) return current!;
      return { agent: { agentStatus: "working", turnId: event.turnId }, kind: "working", reason: "acceptedIntent", settled: false };
    case "agentStatus":
      if (currentTurnId !== event.turnId) return current!;
      return event.status === "completed"
        ? { agent: { agentStatus: "completed", turnId: event.turnId }, kind: "completed", reason: "agentCompleted", settled: false }
        : { kind: "needsAttention", reason: "noActiveTurn", settled: false };
    case "turnCompleted": {
      if (currentTurnId !== event.turnId) return current!;
      if (event.status === "interrupted") return { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: event.turnId };
      if (current?.kind === "completed" && current.reason === "agentCompleted") return current;
      return { kind: "needsAttention", reason: "noActiveTurn", settled: false };
    }
    case "recoveryFailed": return { kind: "needsAttention", reason: "noActiveTurn", settled: false };
    case "providerSystemError": return { kind: "needsAttention", reason: "noActiveTurn", settled: false };
    case "userNeedsAttention":
      if (current?.kind !== "completed" && current?.kind !== "stopped") return current!;
      return { kind: "needsAttention", reason: "noActiveTurn", settled: false };
    case "userCompleted": {
      const agent = current && "agent" in current && current.agent?.turnId
        ? { agentStatus: current.agent.agentStatus, turnId: current.agent.turnId }
        : undefined;
      return { ...(agent ? { agent } : {}), kind: "completed", reason: "userCompleted", settled: false };
    }
    case "userStopped": {
      const agent = current && "agent" in current && current.agent?.turnId
        ? { agentStatus: current.agent.agentStatus, turnId: current.agent.turnId }
        : undefined;
      return { ...(agent ? { agent } : {}), kind: "stopped", reason: "userMarkedStopped", settled: false };
    }
    case "settle":
      if (current?.kind === "needsAttention") {
        return current.reason === "noActiveTurn"
          ? { kind: "completed", reason: "userCompleted", settled: true }
          : current;
      }
      if (current?.kind !== "completed" && current?.kind !== "stopped") return current!;
      if (current.kind === "stopped") {
        const agent = "agent" in current ? current.agent : undefined;
        return { ...(agent ? { agent } : {}), kind: "completed", reason: "userCompleted", settled: true };
      }
      return { ...current, settled: true };
    case "restore":
      if (current?.kind !== "completed" && current?.kind !== "stopped") return current!;
      return { ...current, settled: false };
  }
}

export function projectWorkbenchThreadSidebarEntries(entries: readonly WorkbenchThreadSidebarEntry[]) {
  const childLifecyclesByParent = new Map<string, WorkbenchThreadLifecycle[]>();
  for (const entry of entries) {
    if (entry.entryKind !== "subagent") continue;
    const lifecycles = childLifecyclesByParent.get(entry.parentThreadId) ?? [];
    lifecycles.push(entry.lifecycle);
    childLifecyclesByParent.set(entry.parentThreadId, lifecycles);
  }
  return entries.map((entry) => {
    if (entry.entryKind !== "thread" || entry.lifecycle.kind !== "completed") return entry;
    const childLifecycles = childLifecyclesByParent.get(entry.identity.threadId) ?? [];
    const attention = childLifecycles.find((lifecycle) => lifecycle.kind === "needsAttention");
    if (attention) return { ...entry, lifecycle: attention };
    const working = childLifecycles.find((lifecycle) => lifecycle.kind === "working");
    return working ? { ...entry, lifecycle: working } : entry;
  });
}

export function countDraftPromptTokens(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function createDraftTitle(text: string, maxLength = 80) {
  return normalizeThreadTitleCandidate(text, maxLength) || "Draft";
}
