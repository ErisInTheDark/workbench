/*
 * Exports:
 * - WorkbenchThreadTargetSchema/WorkbenchThreadTarget: canonical blank, draft, provider, and parent-owned subagent identity. Keywords: route, draft, provider, subagent.
 * - WorkbenchThreadDraftSchema/WorkbenchThreadLifecycleSchema/WorkbenchGitArcPlanStateSchema/WorkbenchDurableQuestionnaireSchema/WorkbenchQuestionnaireHistoryEntrySchema/WorkbenchThreadSidebarEntrySchema: strict wire and storage contracts. Keywords: zod, lifecycle, plan, questionnaire, sidebar.
 * - WorkbenchThreadSidebarSnapshotSchema/WorkbenchThreadActivityUpdateSchema: full sidebar state and tiny activity delta contracts. Keywords: sidebar, websocket, revision.
 * - WorkbenchThreadStateOpenResultSchema/WorkbenchThreadStateOpenResult: atomic catalog, tree, and sidebar observation bootstrap. Keywords: open, bootstrap, snapshot.
 * - WorkbenchThreadStateSnapshotSchema/WorkbenchThreadStateRequestSchema/WorkbenchThreadStateMutationResultSchema/WorkbenchThreadTitleMutationResultSchema: multiplexed sidebar, activity, mutation, title, project, and request protocol. Keywords: orchestrator, websocket, revision.
 * - gitArcPreventsThreadSettlement/isWorkbenchThreadSettlementAvailable/areAllUnsnoozedThreadEntriesSettlementReady: identify Git blockers, terminal settlement, and aggregate wake readiness. Keywords: git, arc, settlement, proposal, wake.
 * - getThreadSidebarGroup/groupWorkbenchThreadSidebarEntries/sortThreadSidebarEntries: exhaustive pinned, main, snoozed, and settled grouping with lifecycle-first natural order. Keywords: grouping, pin, sort.
 * - getWorkbenchThreadPlanConflictEntries/createWorkbenchThreadPlanConflictSelector: derive and identity-stabilize visible sibling claim conflicts from one inactive plan and the live sidebar snapshot. Keywords: plan, claim, conflict, sidebar, selector.
 * - normalizeWorkbenchTimestampMs: normalize provider second/millisecond timestamps at the sidebar boundary. Keywords: timestamp, provider, normalization.
 * - resolveWorkbenchThreadTitle: choose a meaningful provider name, first-message preview, or neutral fallback. Keywords: title, preview, uuid.
 * - isWorkbenchThreadStatusProviderOwned/reduceWorkbenchThreadLifecycle/projectWorkbenchThreadSidebarEntries: manual-status eligibility, exact-turn transitions, and direct-child status projection. Keywords: working, attention, completed, stopped, parent.
 * - countDraftPromptTokens/createDraftTitle: durable draft materialization and title rules. Keywords: draft, threshold, title.
 */

import { z } from "zod";

import { gitArcPathsOverlap } from "../git/git-arc-paths";
import { ORCHESTRATOR_RELOAD_SCOPES } from "../orchestrator-reload";
import { areDeeplyEqual } from "../deep-equality";
import { WorkbenchProjectsPayloadSchema, WorkbenchProjectStateUpdateSchema } from "../project/project-state";
import { WorkbenchThreadDisplayOrderSchema } from "./thread-display-order";

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

export const WorkbenchGitArcLifecycleStateSchema = z.object({
  checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  claimedPaths: z.array(z.string().min(1)),
  intentDescription: z.string(),
  intentName: z.string().min(1),
  phase: z.enum(["active", "resolved"]),
  proposals: z.array(z.object({
    proposalId: z.string().min(1),
    status: z.enum(["committed", "proposed"]),
  }).strict()),
  reloadScopes: z.array(z.enum(ORCHESTRATOR_RELOAD_SCOPES)).optional(),
  updatedAt: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.phase === "active" && !value.claimedPaths.length) {
    context.addIssue({ code: "custom", message: "An active Git arc must own at least one claimed path." });
  }
  if (value.phase === "resolved" && value.claimedPaths.length) {
    context.addIssue({ code: "custom", message: "A resolved Git arc cannot own claimed paths." });
  }
});
export type WorkbenchGitArcLifecycleState = z.infer<typeof WorkbenchGitArcLifecycleStateSchema>;

export function gitArcPreventsThreadSettlement(gitArc: WorkbenchGitArcLifecycleState | null | undefined) {
  return Boolean(gitArc?.claimedPaths.length || gitArc?.proposals.some(({ status }) => status === "proposed"));
}

export const WorkbenchGitArcPlanStateSchema = z.object({
  checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  intentDescription: z.string(),
  intentName: z.string().min(1),
  reloadScopes: z.array(z.enum(ORCHESTRATOR_RELOAD_SCOPES)).optional(),
  scopePaths: z.array(z.string().min(1)),
  updatedAt: z.string().min(1),
}).strict();
export type WorkbenchGitArcPlanState = z.infer<typeof WorkbenchGitArcPlanStateSchema>;

const WorkbenchUserInputOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
}).strict();
const WorkbenchUserInputQuestionSchema = z.object({
  allowOther: z.boolean(),
  header: z.string(),
  id: z.string().min(1),
  isSecret: z.boolean(),
  options: z.array(WorkbenchUserInputOptionSchema),
  question: z.string(),
}).strict();
const WorkbenchUserInputRequestSchema = z.object({
  id: z.string().min(1),
  questions: z.array(WorkbenchUserInputQuestionSchema).min(1),
  submitLabel: z.string(),
  summary: z.string(),
  title: z.string(),
}).strict();
const WorkbenchUserInputResponseSchema = z.object({
  answers: z.record(z.string(), z.object({ answers: z.array(z.string()) }).strict()),
}).strict();

export const WorkbenchDurableQuestionnaireSchema = z.object({
  itemId: z.string().nullable(),
  request: WorkbenchUserInputRequestSchema,
  requestKey: z.string().min(1),
  turnId: z.string().nullable(),
}).strict();
export type WorkbenchDurableQuestionnaire = z.infer<typeof WorkbenchDurableQuestionnaireSchema>;

export const WorkbenchQuestionnaireHistoryEntrySchema = WorkbenchDurableQuestionnaireSchema.extend({
  insertAfterItemId: z.string().nullable(),
  insertAfterItemIndex: z.number().int().nonnegative().nullable(),
  resolvedAt: z.number().int().nonnegative(),
  response: WorkbenchUserInputResponseSchema,
  threadId: z.string().min(1),
  turnId: z.string().min(1),
}).strict();
export type WorkbenchQuestionnaireHistoryEntryState = z.infer<typeof WorkbenchQuestionnaireHistoryEntrySchema>;

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
  gitArc: WorkbenchGitArcLifecycleStateSchema.nullable().optional(),
  gitArcPlan: WorkbenchGitArcPlanStateSchema.nullable().optional(),
  identity: ThreadIdentitySchema,
  lifecycle: WorkbenchThreadLifecycleSchema,
  metadata: TopLevelMetadataSchema,
  orderAt: z.number().int().nonnegative().optional(),
  pendingQuestionnaire: WorkbenchDurableQuestionnaireSchema.nullable().optional(),
  questionnaireHistory: z.array(WorkbenchQuestionnaireHistoryEntrySchema).optional(),
}).strict();
const SubagentEntrySchema = SidebarCommonSchema.extend({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().min(1),
  directSubagentIndex: z.number().int().nonnegative(),
  entryKind: z.literal("subagent"),
  gitArc: WorkbenchGitArcLifecycleStateSchema.nullable().optional(),
  gitArcPlan: WorkbenchGitArcPlanStateSchema.nullable().optional(),
  identity: ThreadIdentitySchema,
  lifecycle: WorkbenchThreadLifecycleSchema,
  name: z.string().trim().min(1),
  parentThreadId: z.string().trim().min(1),
  pinned: z.boolean(),
  profileId: z.string(),
  profileName: z.string(),
  projectId: z.string().min(1),
  pendingQuestionnaire: WorkbenchDurableQuestionnaireSchema.nullable().optional(),
  questionnaireHistory: z.array(WorkbenchQuestionnaireHistoryEntrySchema).optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.lifecycle.settled && value.pinned) context.addIssue({ code: "custom", message: "Settled subagents cannot remain locked." });
});

export const WorkbenchThreadSidebarEntrySchema = z.discriminatedUnion("entryKind", [DraftEntrySchema, TopLevelEntrySchema, SubagentEntrySchema]);
export type WorkbenchThreadSidebarEntry = z.infer<typeof WorkbenchThreadSidebarEntrySchema>;
export type WorkbenchTopLevelThreadSidebarEntry = z.infer<typeof TopLevelEntrySchema>;

export const WorkbenchThreadSidebarSnapshotSchema = z.object({
  displayOrder: WorkbenchThreadDisplayOrderSchema.optional(),
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
  displayOrder: WorkbenchThreadDisplayOrderSchema.optional(),
  identity: ThreadIdentitySchema,
  orderAt: z.number().int().nonnegative().optional(),
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

export const WorkbenchThreadStateMutationResultSchema = z.object({
  accepted: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strict();
export type WorkbenchThreadStateMutationResult = z.infer<typeof WorkbenchThreadStateMutationResultSchema>;

export const WorkbenchThreadTitleMutationResultSchema = z.object({
  identity: ThreadIdentitySchema,
  ok: z.literal(true),
  title: z.string().trim().min(1),
}).strict();
export type WorkbenchThreadTitleMutationResult = z.infer<typeof WorkbenchThreadTitleMutationResultSchema>;

const ProjectRequestBase = z.object({ projectId: z.string().trim().min(1) }).strict();
export const WorkbenchThreadStateRequestSchema = z.discriminatedUnion("method", [
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/open"), version: z.literal(2).optional() }),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/close") }),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/refresh") }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema.optional(), identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/intent/accept"), title: z.string().trim().min(1), turnId: z.string().trim().min(1) }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/title/set"), title: z.string().trim().min(1) }),
  ProjectRequestBase.extend({ draft: WorkbenchThreadDraftSchema, method: z.literal("workbench/thread-state/draft/upsert") }),
  ProjectRequestBase.extend({ clientUpdatedAt: z.number().int().nonnegative(), draftId: CanonicalUuidSchema, method: z.literal("workbench/thread-state/draft/delete") }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema, method: z.literal("workbench/thread-state/draft/pin/set"), pinned: z.boolean() }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema, method: z.literal("workbench/thread-state/draft/snooze/set"), snoozed: z.boolean() }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/pin/set"), pinned: z.boolean() }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/snooze/set"), snoozed: z.boolean() }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/settle") }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/restore") }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/status/set"), status: z.enum(["needsAttention", "completed", "stopped"]) }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/questionnaire/dismiss"), requestKey: z.string().min(1) }),
  ProjectRequestBase.extend({ entry: WorkbenchQuestionnaireHistoryEntrySchema, identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/questionnaire/resolve") }),
  ProjectRequestBase.extend({ archived: z.boolean(), identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/archive/set") }),
  ProjectRequestBase.extend({
    beforeKey: z.string().min(1).nullable(),
    method: z.literal("workbench/thread-state/display-order/move"),
    section: z.enum(["pinned", "snoozed", "settledPinned"]),
    sourceKey: z.string().min(1),
  }),
]);
export type WorkbenchThreadStateRequest = z.infer<typeof WorkbenchThreadStateRequestSchema>;

export type WorkbenchThreadSidebarGroup = "pinned" | "main" | "snoozed" | "settled" | "hidden";

export function normalizeWorkbenchTimestampMs(timestamp: number) {
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
  if (entry.entryKind !== "draft" && entry.lifecycle.settled) return "settled";
  const pinned = entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
  return pinned ? "pinned" : "main";
}

export function isWorkbenchThreadSettlementAvailable(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind !== "draft"
    && !entry.lifecycle.settled
    && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")
    && !gitArcPreventsThreadSettlement(entry.gitArc);
}

export function areAllUnsnoozedThreadEntriesSettlementReady(entries: readonly WorkbenchThreadSidebarEntry[]) {
  return entries.every((entry) => {
    const group = getThreadSidebarGroup(entry);
    return group === "hidden" || group === "snoozed" || group === "settled" || isWorkbenchThreadSettlementAvailable(entry);
  });
}

export function groupWorkbenchThreadSidebarEntries(entries: readonly WorkbenchThreadSidebarEntry[]) {
  const visibleEntries = entries.filter((entry) => getThreadSidebarGroup(entry) !== "hidden" && entry.entryKind !== "subagent");
  return {
    mainEntries: visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === "main"),
    pinnedEntries: visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === "pinned"),
    settledEntries: visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === "settled"),
    snoozedEntries: visibleEntries.filter((entry) => getThreadSidebarGroup(entry) === "snoozed"),
  };
}

export function getWorkbenchThreadPlanConflictEntries(
  entries: readonly WorkbenchThreadSidebarEntry[],
  identity: { harness: WorkbenchHarnessId; threadId: string },
) {
  const owner = entries.find((entry): entry is WorkbenchTopLevelThreadSidebarEntry => (
    entry.entryKind === "thread"
    && entry.identity.harness === identity.harness
    && entry.identity.threadId === identity.threadId
  ));
  const scopePaths = owner?.gitArcPlan?.scopePaths ?? [];
  if (!scopePaths.length) return [];
  const conflicts = entries.filter((entry): entry is WorkbenchTopLevelThreadSidebarEntry => (
    entry.entryKind === "thread"
    && (entry.identity.harness !== identity.harness || entry.identity.threadId !== identity.threadId)
    && Boolean(entry.gitArc?.claimedPaths.some((claimedPath) => (
      scopePaths.some((scopePath) => gitArcPathsOverlap(claimedPath, scopePath))
    )))
  ));
  const grouped = groupWorkbenchThreadSidebarEntries(conflicts);
  return [...grouped.pinnedEntries, ...grouped.mainEntries, ...grouped.snoozedEntries, ...grouped.settledEntries] as WorkbenchTopLevelThreadSidebarEntry[];
}

export function createWorkbenchThreadPlanConflictSelector(identity: { harness: WorkbenchHarnessId; threadId: string }) {
  let selected: WorkbenchTopLevelThreadSidebarEntry[] = [];
  return (snapshot: WorkbenchThreadSidebarSnapshot | null) => {
    const next = snapshot ? getWorkbenchThreadPlanConflictEntries(snapshot.entries, identity) : [];
    if (areDeeplyEqual(selected, next)) return selected;
    selected = next;
    return selected;
  };
}

export function sortThreadSidebarEntries(entries: readonly WorkbenchThreadSidebarEntry[]) {
  return [...entries].sort((left, right) => {
    const groupRank: Record<WorkbenchThreadSidebarGroup, number> = { hidden: 4, main: 1, pinned: 0, settled: 3, snoozed: 2 };
    const leftGroup = getThreadSidebarGroup(left);
    const rightGroup = getThreadSidebarGroup(right);
    const presentationOrder = groupRank[leftGroup] - groupRank[rightGroup];
    if (presentationOrder) return presentationOrder;
    const leftPinned = left.entryKind === "subagent" ? left.pinned : left.metadata.pinned;
    const rightPinned = right.entryKind === "subagent" ? right.pinned : right.metadata.pinned;
    if (leftGroup === "settled" && leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    const lifecycleRank = (entry: WorkbenchThreadSidebarEntry) => {
      if (entry.entryKind === "draft") return 0;
      if (entry.lifecycle.kind === "needsAttention" && entry.gitArc?.phase === "active") return 1;
      if (entry.lifecycle.kind === "working") return 2;
      if (entry.lifecycle.kind === "needsAttention") return 3;
      if ((entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped") && !entry.lifecycle.settled) return 4;
      return 5;
    };
    const groupOrder = lifecycleRank(left) - lifecycleRank(right);
    if (groupOrder) return groupOrder;
    const leftOrderAt = left.entryKind === "draft" ? left.draft.createdAt : left.entryKind === "thread" ? left.orderAt ?? left.activityAt : left.createdAt;
    const rightOrderAt = right.entryKind === "draft" ? right.draft.createdAt : right.entryKind === "thread" ? right.orderAt ?? right.activityAt : right.createdAt;
    if (leftOrderAt !== rightOrderAt) return rightOrderAt - leftOrderAt;
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
  | { kind: "userInputDelivered"; turnId: string }
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
    case "userInputDelivered":
      if (
        (current?.kind === "completed" && current.reason === "userCompleted")
        || (current?.kind === "stopped" && (
          current.reason === "userMarkedStopped"
          || current.turnId === event.turnId
        ))
        || (current?.kind === "needsAttention" && current.reason === "pendingInput")
      ) return current;
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
