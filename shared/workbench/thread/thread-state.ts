/*
 * Exports:
 * - WorkbenchThreadTargetSchema/WorkbenchThreadTarget: canonical blank, draft, provider, and parent-owned subagent identity. Keywords: route, draft, provider, subagent.
 * - WorkbenchComposerProfileSlotSchema/WorkbenchComposerSettingsSchema/WorkbenchComposerProfileSelectionSchema: strict daemon target-profile contracts. Keywords: composer, profile, settings, daemon.
 * - WorkbenchThreadDraftSchema/WorkbenchThreadLifecycleSchema/WorkbenchGitArcPlanStateSchema/WorkbenchDurableQuestionnaireSchema/WorkbenchQuestionnaireHistoryEntrySchema/WorkbenchThreadSidebarEntrySchema: strict wire and storage contracts. Keywords: zod, lifecycle, plan, questionnaire, sidebar.
 * - WorkbenchThreadSidebarSnapshotSchema/WorkbenchProjectThreadSidebarsSchema/WorkbenchThreadActivityUpdateSchema: project and global full sidebar state plus tiny activity delta contracts. Keywords: sidebar, websocket, revision, global.
 * - WorkbenchHomeThreadDisplayOrderSnapshotSchema: revisioned home-owned cross-project priority order. Keywords: home, order, global, websocket.
 * - WorkbenchProjectThreadSummaryCountsSchema/WorkbenchProjectThreadSummaryEntrySchema/WorkbenchPinnedThreadSummaryEntrySchema/WorkbenchProjectThreadSummarySchema/createWorkbenchProjectThreadSummary: unsettled and pinned cross-project rows, counts, ordering, and activity with direct-child lifecycle projection. Keywords: project, status, summary, pinned, subagent, activity.
 * - WorkbenchThreadStateOpenResultV2Schema/WorkbenchThreadStateOpenResultSchema/WorkbenchGlobalThreadStateOpenResultSchema/WorkbenchPinnedThreadContextResultSchema: atomic project and global observation bootstraps plus bounded admitted-pin context. Keywords: open, bootstrap, snapshot, compatibility, pinned, global.
 * - WorkbenchThreadStateSnapshotSchema/WorkbenchThreadStateRequestSchema/WorkbenchThreadStateMutationResultSchema/WorkbenchThreadTitleMutationResultSchema: multiplexed sidebar, activity, project-summary, mutation, title, project, and request protocol. Keywords: orchestrator, websocket, revision.
 * - gitArcPreventsThreadSettlement/isWorkbenchThreadSettlementAvailable/areAllUnsnoozedThreadEntriesSettlementReady: identify Git blockers, terminal settlement, and aggregate wake readiness. Keywords: git, arc, settlement, proposal, wake.
 * - getThreadSidebarGroup/groupWorkbenchThreadSidebarEntries: partition already-ordered entries into hidden, pinned, main, snoozed, and settled render sections. Keywords: grouping, pin, sidebar.
 * - WorkbenchThreadPlanIntersections/getWorkbenchThreadPlanIntersections/createWorkbenchThreadPlanIntersectionSelector: describe, derive, and identity-stabilize visible sibling active and planned claim intersections from one inactive plan and the live sidebar snapshot. Keywords: plan, claim, intersection, sidebar, selector.
 * - normalizeWorkbenchTimestampMs: normalize provider second/millisecond timestamps at the sidebar boundary. Keywords: timestamp, provider, normalization.
 * - resolveWorkbenchThreadTitle: choose a meaningful provider name, first-message preview, or neutral fallback. Keywords: title, preview, uuid.
 * - isWorkbenchThreadStatusProviderOwned/reduceWorkbenchThreadLifecycle/projectWorkbenchThreadSidebarEntries: manual-status eligibility, exact-turn transitions, and direct-child status projection. Keywords: working, attention, completed, stopped, parent.
 * - countDraftPromptTokens/createDraftTitle: durable draft materialization and title rules. Keywords: draft, threshold, title.
 */

import { z } from "zod";

import type { WorkbenchComposerProfileTargetSelection, WorkbenchComposerSettings } from "../../types.ts";
import { areDeeplyEqual } from "../deep-equality.ts";
import { gitArcPathsOverlap } from "../git/git-arc-paths.ts";
import { WorkbenchProjectsPayloadSchema, WorkbenchProjectStateUpdateSchema } from "../project/project-state.ts";
import { ThreadDisplayLayoutSchema } from "./thread-display-layout.ts";
import {
  projectWorkbenchThreadDisplaySection,
  resolveWorkbenchThreadDisplayOrder,
  WorkbenchThreadDisplayOrderSchema,
  type WorkbenchThreadDisplayOrder,
} from "./thread-display-order.ts";

export const WorkbenchHarnessSchema = z.enum(["codex", "copilot", "opencode"]);
export type WorkbenchHarnessId = z.infer<typeof WorkbenchHarnessSchema>;

export const WorkbenchComposerProfileSlotSchema = z.discriminatedUnion("kind", [
  z.object({ draftId: z.string().min(1), harness: WorkbenchHarnessSchema, kind: z.literal("draft"), projectId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("new-thread"), projectId: z.string().trim().min(1) }).strict(),
  z.object({ harness: WorkbenchHarnessSchema, kind: z.literal("thread"), projectId: z.string().trim().min(1), threadId: z.string().trim().min(1) }).strict(),
]);

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

export const WorkbenchComposerSettingsSchema = z.object({
  agentPath: z.string().nullable(),
  agentSource: z.enum(["library", "project"]).nullable(),
  harness: WorkbenchHarnessSchema,
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  serviceTier: z.literal("fast").nullable(),
}).strict() as z.ZodType<WorkbenchComposerSettings>;
export type WorkbenchComposerSettingsState = WorkbenchComposerSettings;

export const WorkbenchComposerProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("custom"), settings: WorkbenchComposerSettingsSchema }).strict(),
  z.object({ kind: z.literal("profile"), profileId: z.string().trim().min(1), settings: WorkbenchComposerSettingsSchema }).strict(),
]) as z.ZodType<WorkbenchComposerProfileTargetSelection>;
export type WorkbenchComposerProfileSelectionState = WorkbenchComposerProfileTargetSelection;

export const WorkbenchThreadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ folderId: CanonicalUuidSchema.optional(), kind: z.literal("new") }).strict(),
  z.object({ draftId: CanonicalUuidSchema, kind: z.literal("draft") }).strict(),
  z.object({ harness: WorkbenchHarnessSchema.optional(), kind: z.literal("provider"), threadId: z.string().trim().min(1) }).strict(),
  z.object({ harness: WorkbenchHarnessSchema.optional(), kind: z.literal("subagent"), parentThreadId: z.string().trim().min(1), threadId: z.string().trim().min(1) }).strict(),
]);
export type WorkbenchThreadTarget = z.infer<typeof WorkbenchThreadTargetSchema>;

const WorkbenchThreadDraftInputSchema = z.object({
  agent: z.string().nullable(),
  attachments: z.array(JsonValueSchema),
  clientUpdatedAt: z.number().int().nonnegative(),
  composerSettings: z.union([WorkbenchComposerSettingsSchema, z.record(z.string(), JsonValueSchema)]),
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

export const WorkbenchThreadDraftSchema = WorkbenchThreadDraftInputSchema.transform((draft) => {
  const settings = WorkbenchComposerSettingsSchema.safeParse(draft.composerSettings);
  return {
    ...draft,
    composerSettings: settings.success
      ? settings.data
      : {
        agentPath: draft.agent,
        agentSource: null,
        harness: draft.harness,
        model: draft.model ?? "",
        reasoningEffort: draft.reasoningEffort,
        serviceTier: draft.serviceTier === "fast" ? "fast" as const : null,
      },
  };
});
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
  z.object({ agent: AgentTurnSchema.extend({ agentStatus: z.literal("blocked") }), kind: z.literal("needsAttention"), reason: z.literal("agentBlocked"), settled: z.literal(false) }).strict(),
]);

const LegacyNeedsAttentionLifecycleSchema = z.discriminatedUnion("reason", [
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
]).transform((lifecycle) => lifecycle.kind === "needsAttention" && (
  lifecycle.reason === "turnEnded"
  || lifecycle.reason === "restartRecoveryFailed"
  || lifecycle.reason === "providerSystemError"
)
  ? { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const }
  : lifecycle);
export type WorkbenchThreadLifecycle = z.infer<typeof WorkbenchThreadLifecycleSchema>;

const WorkbenchGitArcProposalStateSchema = z.object({
  proposalId: z.string().min(1),
  rootId: z.string().min(1).optional(),
  status: z.enum(["committed", "proposed"]),
}).strict();

const WorkbenchGitArcMemberStateSchema = z.object({
  checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  claimedPaths: z.array(z.string().min(1)),
  harness: z.string().min(1),
  intentDescription: z.string(),
  intentName: z.string().min(1),
  phase: z.enum(["active", "resolved"]),
  proposals: z.array(WorkbenchGitArcProposalStateSchema),
  repoRoot: z.string().min(1),
  rootId: z.string().min(1),
  rootIds: z.array(z.string().min(1)).min(1),
  threadId: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

export const WorkbenchGitArcLifecycleStateSchema = z.object({
  checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  claimedPaths: z.array(z.string().min(1)),
  intentDescription: z.string(),
  intentName: z.string().min(1),
  members: z.array(WorkbenchGitArcMemberStateSchema).min(1).optional(),
  phase: z.enum(["active", "resolved"]),
  proposals: z.array(WorkbenchGitArcProposalStateSchema),
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
  return Boolean(gitArc?.claimedPaths.length);
}

export const WorkbenchGitArcPlanStateSchema = z.object({
  checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  intentDescription: z.string(),
  intentName: z.string().min(1),
  members: z.array(z.object({
    checkpointCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    harness: z.string().min(1),
    intentDescription: z.string(),
    intentName: z.string().min(1),
    repoRoot: z.string().min(1),
    rootId: z.string().min(1),
    rootIds: z.array(z.string().min(1)).min(1),
    scopePaths: z.array(z.string().min(1)),
    threadId: z.string().min(1),
    updatedAt: z.string().min(1),
  }).strict()).min(1).optional(),
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
  waitingFor: z.enum(["subagents", "other"]).optional(),
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
  waitingFor: z.enum(["subagents", "other"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.lifecycle.settled && value.pinned) context.addIssue({ code: "custom", message: "Settled subagents cannot remain locked." });
});

export const WorkbenchThreadSidebarEntrySchema = z.discriminatedUnion("entryKind", [DraftEntrySchema, TopLevelEntrySchema, SubagentEntrySchema]);
export type WorkbenchThreadSidebarEntry = z.infer<typeof WorkbenchThreadSidebarEntrySchema>;
export type WorkbenchTopLevelThreadSidebarEntry = z.infer<typeof TopLevelEntrySchema>;

export const WorkbenchReloadDirtSnapshotSchema = z.object({
  dirtyScopes: z.array(z.object({
    dependantScopes: z.array(z.string()).optional(),
    description: z.string(),
    destructive: z.boolean(),
    scope: z.string(),
  }).strict()),
  error: z.string().max(500).nullable(),
  pendingScopes: z.array(z.string()),
}).strict();

export const WorkbenchThreadSidebarSnapshotSchema = z.object({
  displayOrder: WorkbenchThreadDisplayOrderSchema.optional(),
  entries: z.array(WorkbenchThreadSidebarEntrySchema),
  error: z.string().max(500).nullable(),
  freshness: z.enum(["loading", "fresh", "partial"]),
  projectId: z.string().min(1),
  reloadDirt: WorkbenchReloadDirtSnapshotSchema.optional(),
  revision: z.number().int().nonnegative(),
}).strict();
export type WorkbenchThreadSidebarSnapshot = z.infer<typeof WorkbenchThreadSidebarSnapshotSchema>;

export const WorkbenchProjectThreadSidebarsSchema = z.object({
  projects: z.array(WorkbenchThreadSidebarSnapshotSchema),
}).strict();
export type WorkbenchProjectThreadSidebars = z.infer<typeof WorkbenchProjectThreadSidebarsSchema>;

export const WorkbenchProjectThreadSummaryCountsSchema = z.object({
  completed: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
  needsAttentionActive: z.number().int().nonnegative(),
  proposedCommit: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative().optional(),
  working: z.number().int().nonnegative(),
}).strict();
export type WorkbenchProjectThreadSummaryCounts = z.infer<typeof WorkbenchProjectThreadSummaryCountsSchema>;

const WorkbenchProjectThreadSummaryStatusSchema = z.enum(["completed", "needsAttention", "needsAttentionActive", "proposedCommit", "stopped", "waiting", "working"]);

export const WorkbenchProjectThreadSummaryEntrySchema = z.object({
  activityAt: z.number().int().nonnegative(),
  identity: ThreadIdentitySchema,
  status: WorkbenchProjectThreadSummaryStatusSchema,
  title: z.string(),
}).strict();
export type WorkbenchProjectThreadSummaryEntry = z.infer<typeof WorkbenchProjectThreadSummaryEntrySchema>;

const PinnedMetadataSchema = z.object({
  archived: z.literal(false),
  pinned: z.literal(true),
  snoozed: z.literal(false),
}).strict();
const PinnedDraftSummaryEntrySchema = SidebarCommonSchema.extend({
  draftId: CanonicalUuidSchema,
  entryKind: z.literal("draft"),
  metadata: PinnedMetadataSchema,
  status: z.literal("draft"),
}).strict();
const PinnedTopLevelSummaryEntrySchema = SidebarCommonSchema.extend({
  entryKind: z.literal("thread"),
  gitArc: WorkbenchGitArcLifecycleStateSchema.nullable().optional(),
  identity: ThreadIdentitySchema,
  lifecycle: WorkbenchThreadLifecycleSchema,
  metadata: PinnedMetadataSchema,
  status: WorkbenchProjectThreadSummaryStatusSchema,
  waitingFor: z.enum(["subagents", "other"]).optional(),
}).strict();
export const WorkbenchPinnedThreadSummaryEntrySchema = z.discriminatedUnion("entryKind", [
  PinnedDraftSummaryEntrySchema,
  PinnedTopLevelSummaryEntrySchema,
]);
export type WorkbenchPinnedThreadSummaryEntry = z.infer<typeof WorkbenchPinnedThreadSummaryEntrySchema>;

export const WorkbenchProjectThreadSummarySchema = z.object({
  counts: WorkbenchProjectThreadSummaryCountsSchema,
  lastThreadUpdateAt: z.number().int().nonnegative().nullable(),
  pinnedThreads: z.array(WorkbenchPinnedThreadSummaryEntrySchema).default([]),
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  unsettledThreads: z.array(WorkbenchProjectThreadSummaryEntrySchema),
}).strict();
export type WorkbenchProjectThreadSummary = z.infer<typeof WorkbenchProjectThreadSummarySchema>;

export const WorkbenchProjectThreadSummariesSchema = z.object({
  projects: z.array(WorkbenchProjectThreadSummarySchema),
}).strict();
export type WorkbenchProjectThreadSummaries = z.infer<typeof WorkbenchProjectThreadSummariesSchema>;

export const WorkbenchPinnedThreadLayoutSnapshotSchema = z.object({
  displayOrder: WorkbenchThreadDisplayOrderSchema,
  revision: z.number().int().nonnegative(),
  updateKind: z.literal("pinnedThreadLayout"),
}).strict();
export type WorkbenchPinnedThreadLayoutSnapshot = z.infer<typeof WorkbenchPinnedThreadLayoutSnapshotSchema>;

export const WorkbenchHomeThreadDisplayOrderSchema = ThreadDisplayLayoutSchema.omit({ folders: true }).strict();
export type WorkbenchHomeThreadDisplayOrder = z.infer<typeof WorkbenchHomeThreadDisplayOrderSchema>;

export const WorkbenchHomeThreadDisplayOrderSnapshotSchema = z.object({
  displayOrder: WorkbenchHomeThreadDisplayOrderSchema,
  revision: z.number().int().nonnegative(),
  updateKind: z.literal("homeThreadDisplayOrder"),
}).strict();
export type WorkbenchHomeThreadDisplayOrderSnapshot = z.infer<typeof WorkbenchHomeThreadDisplayOrderSnapshotSchema>;

export const WorkbenchThreadStateOpenResultV2Schema = z.object({
  catalog: WorkbenchProjectsPayloadSchema,
  project: WorkbenchProjectStateUpdateSchema.nullable(),
  sidebar: WorkbenchThreadSidebarSnapshotSchema,
}).strict();
export type WorkbenchThreadStateOpenResultV2 = z.infer<typeof WorkbenchThreadStateOpenResultV2Schema>;

export const WorkbenchThreadStateOpenResultSchema = WorkbenchThreadStateOpenResultV2Schema.extend({
  pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshotSchema.default(() => ({
    displayOrder: {},
    revision: 0,
    updateKind: "pinnedThreadLayout" as const,
  })),
  projectThreads: WorkbenchProjectThreadSummariesSchema.default(() => ({ projects: [] })),
});
export type WorkbenchThreadStateOpenResult = z.infer<typeof WorkbenchThreadStateOpenResultSchema>;

export const WorkbenchGlobalThreadStateOpenResultV4Schema = z.object({
  catalog: WorkbenchProjectsPayloadSchema,
  pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshotSchema,
  projectSidebars: WorkbenchProjectThreadSidebarsSchema,
}).strict();
export const WorkbenchGlobalThreadStateOpenResultV5Schema = WorkbenchGlobalThreadStateOpenResultV4Schema.extend({
  homeThreadDisplayOrder: WorkbenchHomeThreadDisplayOrderSnapshotSchema,
  version: z.literal(5),
}).strict();
export const WorkbenchGlobalThreadStateOpenResultV6Schema = WorkbenchGlobalThreadStateOpenResultV4Schema.extend({
  homeThreadDisplayOrder: WorkbenchHomeThreadDisplayOrderSnapshotSchema,
  version: z.literal(6),
}).strict();
export const WorkbenchGlobalThreadStateOpenResultSchema = z.union([
  WorkbenchGlobalThreadStateOpenResultV6Schema,
  WorkbenchGlobalThreadStateOpenResultV5Schema,
  WorkbenchGlobalThreadStateOpenResultV4Schema,
]);
export type WorkbenchGlobalThreadStateOpenResult = z.infer<typeof WorkbenchGlobalThreadStateOpenResultSchema>;

export const WorkbenchPinnedThreadContextResultSchema = z.object({
  context: z.object({
    entries: z.array(WorkbenchThreadSidebarEntrySchema),
    projectId: z.string().min(1),
    target: WorkbenchThreadTargetSchema,
  }).strict().nullable(),
}).strict();
export type WorkbenchPinnedThreadContextResult = z.infer<typeof WorkbenchPinnedThreadContextResultSchema>;

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

export const WorkbenchProjectThreadSummaryUpdateSchema = z.object({
  summary: WorkbenchProjectThreadSummarySchema,
  updateKind: z.literal("projectThreadSummary"),
}).strict();
export type WorkbenchProjectThreadSummaryUpdate = z.infer<typeof WorkbenchProjectThreadSummaryUpdateSchema>;

export const WorkbenchProjectThreadSidebarUpdateSchema = z.object({
  sidebar: WorkbenchThreadSidebarSnapshotSchema,
  updateKind: z.literal("projectThreadSidebar"),
}).strict();
export type WorkbenchProjectThreadSidebarUpdate = z.infer<typeof WorkbenchProjectThreadSidebarUpdateSchema>;

export const WorkbenchThreadStateSnapshotSchema = z.union([
  WorkbenchThreadSidebarSnapshotSchema,
  WorkbenchThreadActivityUpdateSchema,
  WorkbenchHomeThreadDisplayOrderSnapshotSchema,
  WorkbenchPinnedThreadLayoutSnapshotSchema,
  WorkbenchProjectThreadSidebarUpdateSchema,
  WorkbenchProjectThreadSummaryUpdateSchema,
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
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/open"), version: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional() }),
  z.object({ method: z.literal("workbench/thread-state/global/open"), version: z.union([z.literal(4), z.literal(5), z.literal(6)]) }).strict(),
  z.object({ method: z.literal("workbench/thread-state/global/close") }).strict(),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/close") }),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/refresh") }),
  ProjectRequestBase.extend({ method: z.literal("workbench/thread-state/pin/open"), target: WorkbenchThreadTargetSchema }),
  ProjectRequestBase.extend({ draftId: CanonicalUuidSchema.optional(), identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/intent/accept"), title: z.string().trim().min(1), turnId: z.string().trim().min(1) }),
  ProjectRequestBase.extend({ identity: ThreadIdentitySchema, method: z.literal("workbench/thread-state/title/set"), title: z.string().trim().min(1) }),
  ProjectRequestBase.extend({ draft: WorkbenchThreadDraftSchema, folderId: CanonicalUuidSchema.optional(), method: z.literal("workbench/thread-state/draft/upsert") }),
  z.object({
    destinationProjectId: z.string().trim().min(1),
    draftId: CanonicalUuidSchema,
    method: z.literal("workbench/thread-state/draft/move"),
    sourceProjectId: z.string().trim().min(1),
  }).strict().superRefine((value, context) => {
    if (value.destinationProjectId === value.sourceProjectId) {
      context.addIssue({ code: "custom", message: "Draft move projects must differ.", path: ["destinationProjectId"] });
    }
  }),
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
    folderId: CanonicalUuidSchema,
    method: z.literal("workbench/thread-state/display-order/folder/create"),
    sourceKey: z.string().min(1),
    title: z.string().trim().min(1).max(80),
  }),
  ProjectRequestBase.extend({
    folderId: CanonicalUuidSchema,
    method: z.literal("workbench/thread-state/display-order/folder/title/set"),
    title: z.string().trim().min(1).max(80),
  }),
  ProjectRequestBase.extend({
    beforeKey: z.string().min(1).nullable(),
    destinationFolderId: CanonicalUuidSchema.nullable(),
    method: z.literal("workbench/thread-state/display-order/move"),
    section: z.enum(["pinned", "snoozed", "settled"]),
    sourceKey: z.string().min(1),
  }),
  z.object({
    beforeKey: z.string().min(1).nullable(),
    destinationFolderKey: z.string().min(1).nullable(),
    method: z.literal("workbench/thread-state/home-display-order/move"),
    section: z.enum(["pinned", "snoozed", "settled"]),
    sourceKey: z.string().min(1),
  }).strict(),
  z.object({
    folderId: CanonicalUuidSchema,
    method: z.literal("workbench/thread-state/pinned-display-order/folder/create"),
    sourceKey: z.string().min(1),
    title: z.string().trim().min(1).max(80),
  }).strict(),
  z.object({
    folderId: CanonicalUuidSchema,
    method: z.literal("workbench/thread-state/pinned-display-order/folder/title/set"),
    title: z.string().trim().min(1).max(80),
  }).strict(),
  z.object({
    beforeKey: z.string().min(1).nullable(),
    destinationFolderId: CanonicalUuidSchema.nullable(),
    method: z.literal("workbench/thread-state/pinned-display-order/move"),
    sourceKey: z.string().min(1),
  }).strict(),
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
  if (entry.entryKind !== "draft" && entry.lifecycle.settled) return "settled";
  if (entry.entryKind !== "subagent" && entry.metadata.snoozed) return "snoozed";
  const pinned = entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
  return pinned ? "pinned" : "main";
}

export function isWorkbenchThreadSettlementAvailable(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind !== "draft"
    && !entry.waitingFor
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

export interface WorkbenchThreadPlanIntersections {
  activeEntries: WorkbenchTopLevelThreadSidebarEntry[];
  hasPlannedClaims: boolean;
  plannedEntries: WorkbenchTopLevelThreadSidebarEntry[];
}

const EMPTY_WORKBENCH_THREAD_PLAN_INTERSECTIONS: WorkbenchThreadPlanIntersections = {
  activeEntries: [],
  hasPlannedClaims: false,
  plannedEntries: [],
};

function orderWorkbenchTopLevelThreadEntries(entries: readonly WorkbenchTopLevelThreadSidebarEntry[]) {
  const grouped = groupWorkbenchThreadSidebarEntries(entries);
  return [...grouped.pinnedEntries, ...grouped.mainEntries, ...grouped.snoozedEntries, ...grouped.settledEntries] as WorkbenchTopLevelThreadSidebarEntry[];
}

export function getWorkbenchThreadPlanIntersections(
  entries: readonly WorkbenchThreadSidebarEntry[],
  identity: { harness: WorkbenchHarnessId; threadId: string },
): WorkbenchThreadPlanIntersections {
  const owner = entries.find((entry): entry is WorkbenchTopLevelThreadSidebarEntry => (
    entry.entryKind === "thread"
    && entry.identity.harness === identity.harness
    && entry.identity.threadId === identity.threadId
  ));
  const scopePaths = owner?.gitArcPlan?.scopePaths ?? [];
  if (!scopePaths.length) return EMPTY_WORKBENCH_THREAD_PLAN_INTERSECTIONS;
  const candidates = entries.filter((entry): entry is WorkbenchTopLevelThreadSidebarEntry => (
    entry.entryKind === "thread"
    && (entry.identity.harness !== identity.harness || entry.identity.threadId !== identity.threadId)
  ));
  const overlapsPlan = (candidatePaths: readonly string[]) => candidatePaths.some((candidatePath) => (
    scopePaths.some((scopePath) => gitArcPathsOverlap(candidatePath, scopePath))
  ));
  return {
    activeEntries: orderWorkbenchTopLevelThreadEntries(candidates.filter((entry) => overlapsPlan(entry.gitArc?.claimedPaths ?? []))),
    hasPlannedClaims: true,
    plannedEntries: orderWorkbenchTopLevelThreadEntries(candidates.filter((entry) => overlapsPlan(entry.gitArcPlan?.scopePaths ?? []))),
  };
}

export function createWorkbenchThreadPlanIntersectionSelector(identity: { harness: WorkbenchHarnessId; threadId: string }) {
  let selected = EMPTY_WORKBENCH_THREAD_PLAN_INTERSECTIONS;
  return (snapshot: WorkbenchThreadSidebarSnapshot | null) => {
    const next = snapshot ? getWorkbenchThreadPlanIntersections(snapshot.entries, identity) : EMPTY_WORKBENCH_THREAD_PLAN_INTERSECTIONS;
    if (areDeeplyEqual(selected, next)) return selected;
    selected = next;
    return selected;
  };
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
        : { agent: { agentStatus: "blocked", turnId: event.turnId }, kind: "needsAttention", reason: "agentBlocked", settled: false };
    case "turnCompleted": {
      if (currentTurnId !== event.turnId) return current!;
      if (event.status === "interrupted") return { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: event.turnId };
      if (current?.kind === "completed" && current.reason === "agentCompleted") return current;
      if (current?.kind === "needsAttention" && current.reason === "agentBlocked") return current;
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
        return current.reason === "noActiveTurn" || current.reason === "agentBlocked"
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
  const childrenByParent = new Map<string, Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>[]>();
  for (const entry of entries) {
    if (entry.entryKind !== "subagent") continue;
    childrenByParent.set(entry.parentThreadId, [...childrenByParent.get(entry.parentThreadId) ?? [], entry]);
  }
  return entries.map((entry) => {
    if (
      entry.entryKind !== "thread"
      || (entry.lifecycle.kind !== "completed" && entry.waitingFor !== "subagents")
    ) return entry;
    const children = childrenByParent.get(entry.identity.threadId) ?? [];
    const attention = children.find(({ lifecycle }) => !lifecycle.settled && lifecycle.kind === "needsAttention");
    const working = children.find(({ lifecycle, waitingFor }) => !lifecycle.settled && lifecycle.kind === "working" && !waitingFor);
    const waiting = children.find(({ lifecycle, waitingFor }) => !lifecycle.settled && lifecycle.kind === "working" && Boolean(waitingFor));
    const { waitingFor: _waitingFor, ...withoutWaiting } = entry;
    if (attention) return { ...withoutWaiting, lifecycle: attention.lifecycle };
    if (working) return { ...withoutWaiting, lifecycle: working.lifecycle };
    if (waiting) return { ...withoutWaiting, lifecycle: waiting.lifecycle, waitingFor: "subagents" as const };
    return entry;
  });
}

export function createWorkbenchProjectThreadSummary(
  projectId: string,
  entries: readonly WorkbenchThreadSidebarEntry[],
  revision: number,
  displayOrder: WorkbenchThreadDisplayOrder = {},
): WorkbenchProjectThreadSummary {
  const counts: WorkbenchProjectThreadSummaryCounts = {
    completed: 0,
    needsAttention: 0,
    needsAttentionActive: 0,
    proposedCommit: 0,
    stopped: 0,
    waiting: 0,
    working: 0,
  };
  const projectedEntries = projectWorkbenchThreadSidebarEntries(entries);
  const unsettledThreads: WorkbenchProjectThreadSummaryEntry[] = [];
  const statusByThreadKey = new Map<string, WorkbenchProjectThreadSummaryEntry["status"]>();
  for (const entry of projectedEntries) {
    if (entry.entryKind !== "thread" || entry.lifecycle.settled || entry.metadata.snoozed) continue;
    const status: WorkbenchProjectThreadSummaryEntry["status"] = entry.waitingFor
      ? "waiting"
      : entry.lifecycle.kind === "working"
        ? "working"
      : entry.lifecycle.kind === "needsAttention"
        ? entry.gitArc?.phase === "active" ? "needsAttentionActive" : "needsAttention"
        : entry.lifecycle.kind === "stopped"
          ? "stopped"
          : entry.gitArc?.proposals.some(({ status: proposalStatus }) => proposalStatus === "proposed")
            ? "proposedCommit"
            : "completed";
    counts[status] += 1;
    statusByThreadKey.set(`${entry.identity.harness}:${entry.identity.threadId}`, status);
    unsettledThreads.push({
      activityAt: entry.activityAt,
      identity: entry.identity,
      status,
      title: entry.title,
    });
  }
  const resolved = resolveWorkbenchThreadDisplayOrder(projectedEntries, displayOrder);
  const pinnedThreads = projectWorkbenchThreadDisplaySection(resolved.entries, resolved.displayOrder, "pinned")
    .flatMap((item) => item.itemKind === "folder" ? item.entries : [item.entry])
    .flatMap<WorkbenchPinnedThreadSummaryEntry>((entry) => {
      if (entry.entryKind === "draft") {
        return [{
          activityAt: entry.activityAt,
          draftId: entry.draft.draftId,
          entryKind: "draft",
          metadata: { archived: false, pinned: true, snoozed: false },
          status: "draft",
          title: entry.title,
        }];
      }
      if (entry.entryKind !== "thread") return [];
      return [{
        activityAt: entry.activityAt,
        entryKind: "thread",
        ...(entry.gitArc !== undefined ? { gitArc: entry.gitArc } : {}),
        identity: entry.identity,
        lifecycle: entry.lifecycle,
        metadata: { archived: false, pinned: true, snoozed: false },
        status: statusByThreadKey.get(`${entry.identity.harness}:${entry.identity.threadId}`) ?? "completed",
        title: entry.title,
        ...(entry.waitingFor ? { waitingFor: entry.waitingFor } : {}),
      }];
    });
  const lastThreadUpdateAt = entries.reduce<number | null>(
    (latest, entry) => entry.entryKind === "draft" ? latest : Math.max(latest ?? 0, entry.activityAt),
    null,
  );
  const { waiting, ...countsWithoutWaiting } = counts;
  return {
    counts: waiting ? counts : countsWithoutWaiting,
    lastThreadUpdateAt,
    pinnedThreads,
    projectId,
    revision,
    unsettledThreads,
  };
}

export function countDraftPromptTokens(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function createDraftTitle(text: string, maxLength = 80) {
  return normalizeThreadTitleCandidate(text, maxLength) || "Draft";
}
