/*
 * Exports:
 * - WorkspaceSourcePhaseSchema/WorkspaceSourcePhase: independently observed source freshness.
 * - WorkspaceTranscriptStateSchema/WorkspaceTranscriptState: caller-local transcript subscription freshness.
 * - DaemonWorkspaceQuerySchema/DaemonWorkspaceQuery: demanded daemon facts (incl. the running checkout's `update` position, a project's unclaimed working-tree `workingTreeSummary` and a provider's `accountLimits`), independent of socket selection.
 * - DaemonWorkspaceObserveSchema/DaemonWorkspaceObserve: named daemon observation arguments.
 * - DaemonWorkspaceObservationSchema/DaemonWorkspaceObservation: versioned partial daemon results.
 * - WorkspaceProjectReferenceSchema/WorkspaceProjectReference: registered project or explicit observed location.
 * - WorkspaceQuerySchema/WorkspaceQuery: browser workspace intents without transport destinations (incl. relayed `daemonUpdate` and the app's `reloadOperation`).
 * - WorkspaceDaemonFactSchema/WorkspaceDaemonFact: app-owned daemon connection facts.
 * - WorkspaceProjectsSchema/WorkspaceProjects: merged and not-yet-registered projects.
 * - WorkspaceProjectGroupsSchema/WorkspaceProjectGroups: app-owned cross-daemon sidebar project pools.
 * - WorkspaceThreadRowsSchema/WorkspaceThreadRows: source-qualified selected thread rows.
 * - WorkspaceThreadOwnerSchema/WorkspaceThreadOwner: resolved ownership or a scoped unresolved result.
 * - WorkspaceObservationSchema/WorkspaceObservation: independently revisioned app query results.
 * - WorkspaceObserveSchema/WorkspaceObserve: replace one named observation's arguments.
 * - WorkspaceReleaseSchema: release only the matching observation generation.
 * - WORKSPACE_RETARGET_METHOD/DaemonWorkspaceRetargetSchema/WorkspaceRetargetSchema/WorkspaceRetargetResultSchema: swap a live observation's arguments, answered with a delta.
 * - WorkspaceThreadSummarySchema/WorkspaceThreadSummariesSchema: located thread summaries a `threadSummaries` batch returns, keyed by thread id.
 * - WORKSPACE_OBSERVE_METHOD/WORKSPACE_RELEASE_METHOD/WORKSPACE_UPDATED_METHOD: shared observation protocol.
 * - WORKSPACE_DELTA_METHOD/WorkspaceObservationDeltaSchema/WorkspaceObservationDelta: keyed delta onto one observation revision.
 * - WorkspaceThreadRow/workspaceThreadRowKey: one app thread row and its delta identity.
 * - WorkspaceArchivedThreadsSchema/WorkspaceArchivedThreads: paged archived rows with per-project totals.
 * - daemonObservationShape/workspaceObservationShape: how each observation kind decomposes into keyed deltas.
 * Queries include a thread's live `threadVis` sessions and one stored `visSnapshot`.
 */
import { z } from "zod";
import {
  DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ProjectIdentityKeySchema,
  ThreadReferenceSchema,
} from "../identity";
import {
  WorkbenchProjectStateUpdateSchema, WorkbenchProjectsPayloadSchema, WorkbenchProjectOptionSchema,
  WorkbenchProjectSnapshotSchema, WorkbenchProjectTreeNodeSchema, WorkbenchProjectTreeNodeFieldsSchema,
} from "../project/project-state";
import {
  ProjectLocationReferenceSchema, WorkbenchProjectLocationsPayloadSchema,
} from "../project/project-location";
import {
  WorkbenchProjectThreadSummarySchema, WorkbenchThreadSidebarEntrySchema,
  WorkbenchThreadSidebarSnapshotSchema, WorkbenchThreadObservationSnapshotSchema,
  WorkbenchProjectThreadSummaryCountsSchema, WorkbenchPinnedThreadSummaryEntrySchema,
  WorkbenchProjectThreadSummaryEntrySchema, ThreadRuntimeRecordSchema, ThreadRuntimeSchema,
} from "../thread/thread-state";
import { WorkbenchThreadIdentityResolutionSchema } from "../thread/workbench-thread-identity";
import { LocatedThreadSummariesSchema, LocatedThreadSummarySchema, ThreadSummarySchema } from "../thread/thread-summary";
import { PresentationSnapshotSchema } from "../../state/workbench-presentation-state";
import type { WorkbenchClientStateResponse } from "../../state/workbench-client-state";
import { conformWorkbenchClientStateResponse } from "../../state/workbench-client-state-conformance";
import { appStateClientTables } from "../../state/workbench-app-state-schema";
import { tablePrimaryKeyColumns } from "../../database/schema/schema-definition";
import { WorkbenchNetworkSnapshotSchema } from "../../http/workbench-network";
import { WorkbenchDaemonReloadDirtEnvelopeSchema } from "../daemon-reload";
import { InstallationUpdateSchema } from "../installation-update";
import { WorkbenchReloadOperationSchema } from "../../reload/workbench-reload";
import { WorkbenchSearchRequestSchema } from "../search/workbench-search";
import { WorkspaceSearchResponseSchema } from "./workspace-commands";
import { WorkbenchStatsReadRequestSchema } from "../stats/workbench-stats-contract";
import { WorkbenchStatsObservedResponseSchema } from "../stats/workbench-stats-conformance";
import { ObservationDeltaSchema, observationShape, type ObservationShape } from "./observation-patch";
import { WorkingTreeSummarySchema } from "../git/working-tree-contracts";
import { WorkbenchAccountLimitsSchema } from "../provider/provider-account";
import { ProviderKeySchema } from "../provider/provider-key";
import { VisSnapshotKindSchema, VisSnapshotSchema, VisThreadSchema, type VisLiveSession } from "../vis/vis-contract";
import {
  WorkbenchThreadSidebarRowSchema, WorkbenchThreadSidebarRowSnapshotSchema,
  WorkbenchThreadSidebarRowVersionSchema, sidebarRowKey,
} from "../thread/thread-sidebar-row";

export const WORKSPACE_OBSERVE_METHOD = "workspace/observe";
export const WORKSPACE_RELEASE_METHOD = "workspace/release";
export const WORKSPACE_UPDATED_METHOD = "workspace/updated";
export const WORKSPACE_DELTA_METHOD = "workspace/delta";
export const WORKSPACE_RETARGET_METHOD = "workspace/retarget";

export const WorkspaceSourcePhaseSchema = z.enum(["pending", "current", "stale", "failed", "unavailable"]);
export type WorkspaceSourcePhase = z.infer<typeof WorkspaceSourcePhaseSchema>;
const failure = z.string().max(512).nullable();
export const WorkspaceTranscriptStateSchema = z.object({
  subscriptionId: z.string().min(1).max(256), phase: WorkspaceSourcePhaseSchema, failure,
}).strict();
export type WorkspaceTranscriptState = z.infer<typeof WorkspaceTranscriptStateSchema>;
const revision = z.number().int().nonnegative();
/** Archived rows are paged newest-first; the caller grows `limit` to see more. */
const archivedLimit = z.number().int().min(1).max(500);
const envelope = {
  subscriptionId: z.uuid(),
  generation: revision,
  revision,
  phase: WorkspaceSourcePhaseSchema,
  failure,
};

export const DaemonWorkspaceQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtime") }).strict(),
  z.object({ kind: z.literal("update") }).strict(),
  z.object({ kind: z.literal("catalogue") }).strict(),
  z.object({ kind: z.literal("summaries") }).strict(),
  z.object({ kind: z.literal("projectPlacement") }).strict(),
  z.object({
    kind: z.literal("projectThreads"), projectIds: z.array(ProjectIdSchema),
    sidebarRowVersion: WorkbenchThreadSidebarRowVersionSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("projectTree"), projectId: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("workingTreeSummary"), projectId: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("accountLimits"), provider: ProviderKeySchema }).strict(),
  z.object({ kind: z.literal("threadIdentity"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("thread"), projectId: ProjectIdSchema, threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("stats"), request: WorkbenchStatsReadRequestSchema }).strict(),
  z.object({ kind: z.literal("archivedThreads"), projectIds: z.array(ProjectIdSchema), limit: archivedLimit }).strict(),
  z.object({ kind: z.literal("threadVis"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("visSnapshot"), sessionId: z.uuid(), snapshotKind: VisSnapshotKindSchema }).strict(),
  /** One batch of thread summaries; callers retarget the id set instead of observing each thread. */
  z.object({ kind: z.literal("threadSummaries"), threadIds: z.array(ThreadReferenceSchema) }).strict(),
]);
export type DaemonWorkspaceQuery = z.infer<typeof DaemonWorkspaceQuerySchema>;
export const DaemonWorkspaceObserveSchema = z.object({
  subscriptionId: z.uuid(),
  generation: revision,
  query: DaemonWorkspaceQuerySchema,
}).strict();
export type DaemonWorkspaceObserve = z.infer<typeof DaemonWorkspaceObserveSchema>;
export const WorkspaceReleaseSchema = z.object({
  subscriptionId: z.uuid(),
  generation: revision,
}).strict();
/** Swap a live observation's arguments for the same kind; the change arrives as an ordinary delta against its last value. */
export const DaemonWorkspaceRetargetSchema = DaemonWorkspaceObserveSchema;
export type DaemonWorkspaceRetarget = DaemonWorkspaceObserve;
export const WorkspaceRetargetResultSchema = z.object({ revision }).strict();

/**
 * One stats section. `refinement` stays pending while published data is provisional: claim hotspots arrive
 * before rename history is merged. Sections without a refinement step publish it as current.
 */
const statsObservation = {
  refinement: WorkspaceSourcePhaseSchema,
  data: WorkbenchStatsObservedResponseSchema.nullable(),
};

const projectRows = z.object({
  projectId: ProjectIdSchema,
  phase: WorkspaceSourcePhaseSchema,
  failure,
  sidebar: WorkbenchThreadSidebarRowSnapshotSchema.nullable(),
}).strict();
const archivedProject = z.object({
  projectId: ProjectIdSchema,
  phase: WorkspaceSourcePhaseSchema,
  failure,
  total: z.number().int().nonnegative(),
  rows: z.array(WorkbenchThreadSidebarRowSchema),
}).strict();

export const DaemonWorkspaceObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("runtime"), data: WorkbenchDaemonReloadDirtEnvelopeSchema.shape.snapshot }).strict(),
  z.object({ ...envelope, kind: z.literal("update"), data: InstallationUpdateSchema }).strict(),
  z.object({
    ...envelope, kind: z.literal("catalogue"),
    catalogue: WorkbenchProjectsPayloadSchema.nullable(),
    locations: WorkbenchProjectLocationsPayloadSchema.nullable(),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("summaries"),
    projects: z.array(WorkbenchProjectThreadSummarySchema),
    pendingProjectIds: z.array(ProjectIdSchema),
    failures: z.array(z.object({ projectId: ProjectIdSchema, message: z.string().max(512) }).strict()),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("projectPlacement"),
    projects: z.array(z.object({ projectId: ProjectIdSchema, hasUnarchivedWork: z.boolean() }).strict()),
    pendingProjectIds: z.array(ProjectIdSchema),
    failures: z.array(z.object({ projectId: ProjectIdSchema, message: z.string().max(512) }).strict()),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("projectThreads"), projects: z.array(projectRows),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("projectTree"), project: WorkbenchProjectStateUpdateSchema.nullable(),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("workingTreeSummary"), summary: WorkingTreeSummarySchema.nullable(),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("accountLimits"), limits: WorkbenchAccountLimitsSchema.nullable(),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("threadIdentity"), identity: WorkbenchThreadIdentityResolutionSchema.nullable(),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("thread"), data: WorkbenchThreadObservationSnapshotSchema.nullable(),
    runtime: ThreadRuntimeRecordSchema.default({}),
  }).strict(),
  z.object({ ...envelope, kind: z.literal("stats"), ...statsObservation }).strict(),
  z.object({ ...envelope, kind: z.literal("archivedThreads"), projects: z.array(archivedProject) }).strict(),
  z.object({ ...envelope, kind: z.literal("threadVis"), data: VisThreadSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("visSnapshot"), data: VisSnapshotSchema.nullable() }).strict(),
  /** Every requested thread this daemon holds, with its project; null for threads it does not hold. */
  z.object({ ...envelope, kind: z.literal("threadSummaries"), summaries: LocatedThreadSummariesSchema }).strict(),
]);
export type DaemonWorkspaceObservation = z.infer<typeof DaemonWorkspaceObservationSchema>;

export const WorkspaceProjectReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("logical"), projectId: LogicalProjectIdSchema }).strict(),
  z.object({ kind: z.literal("location"), location: ProjectLocationReferenceSchema }).strict(),
]);
export type WorkspaceProjectReference = z.infer<typeof WorkspaceProjectReferenceSchema>;

export const WorkspaceQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("search"), request: WorkbenchSearchRequestSchema }).strict(),
  z.object({ kind: z.literal("daemonRuntime"), daemonId: DaemonIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("daemonUpdate"), daemonId: DaemonIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("network") }).strict(),
  z.object({ kind: z.literal("projects"), daemonIds: z.array(DaemonIdSchema).optional() }).strict(),
  z.object({ kind: z.literal("projectGroups") }).strict(),
  z.object({
    kind: z.literal("projectThreads"),
    projects: z.array(WorkspaceProjectReferenceSchema).nullable(),
    sidebarRowVersion: WorkbenchThreadSidebarRowVersionSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("projectTree"), location: ProjectLocationReferenceSchema }).strict(),
  z.object({ kind: z.literal("workingTreeSummary"), location: ProjectLocationReferenceSchema }).strict(),
  /** `daemonId` null observes the app's attached daemon. */
  z.object({ kind: z.literal("accountLimits"), provider: ProviderKeySchema, daemonId: DaemonIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal("threadOwner"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("thread"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("presentation") }).strict(),
  z.object({
    kind: z.literal("appState"), browserStateId: z.uuid().nullable(),
    schemaVersion: revision.optional(),
  }).strict(),
  z.object({ kind: z.literal("runtime") }).strict(),
  z.object({ kind: z.literal("reloadOperation") }).strict(),
  /** Merged across every daemon holding the referenced projects; null reads every project on every daemon. */
  z.object({
    kind: z.literal("stats"),
    projects: z.array(WorkspaceProjectReferenceSchema).nullable(),
    request: WorkbenchStatsReadRequestSchema.omit({ projectIds: true }),
  }).strict(),
  z.object({
    kind: z.literal("archivedThreads"),
    projects: z.array(WorkspaceProjectReferenceSchema).nullable(),
    limit: archivedLimit,
  }).strict(),
  /** A thread's live vis sessions, from the daemon that owns the thread. */
  z.object({ kind: z.literal("threadVis"), threadId: ThreadReferenceSchema }).strict(),
  /** One stored vis moment; the thread routes it to its daemon. */
  z.object({ kind: z.literal("visSnapshot"), threadId: ThreadReferenceSchema, sessionId: z.uuid(), snapshotKind: VisSnapshotKindSchema }).strict(),
  /** Summaries for every thread a page shows, wherever each lives; the browser retargets one batch as displays mount. */
  z.object({ kind: z.literal("threadSummaries"), threadIds: z.array(ThreadReferenceSchema) }).strict(),
]);
export type WorkspaceQuery = z.infer<typeof WorkspaceQuerySchema>;
/** Swap a live observation's arguments for the same kind; the change arrives as an ordinary delta against its last value. */
export const WorkspaceRetargetSchema = z.object({
  subscriptionId: z.uuid(),
  generation: revision,
  query: WorkspaceQuerySchema,
}).strict();
export type WorkspaceRetarget = z.infer<typeof WorkspaceRetargetSchema>;

export const WorkspaceDaemonFactSchema = z.object({
  daemonId: DaemonIdSchema,
  hostname: z.string(),
  connection: z.enum(["idle", "connecting", "current", "reconnecting", "sleeping", "failed", "revoked"]),
  generation: revision,
  failure,
}).strict();
export type WorkspaceDaemonFact = z.infer<typeof WorkspaceDaemonFactSchema>;

const logicalProject = z.object({
  id: LogicalProjectIdSchema,
  matchKey: z.string(),
  label: z.string(),
  storedLabel: z.string().optional(),
  displayName: z.string().optional(),
  displayPath: z.string().nullable().optional(),
  locations: z.array(z.object({
    target: ProjectLocationReferenceSchema,
    daemonId: DaemonIdSchema,
    hostname: z.string(),
    name: z.string(),
    rootPath: z.string(),
    displayPath: z.string().optional(),
    project: WorkbenchProjectOptionSchema.nullable(),
  }).strict()),
  observedLocations: z.array(z.object({
    daemonId: DaemonIdSchema,
    projectId: ProjectIdSchema,
    hostname: z.string(),
    rootPath: z.string(),
    project: WorkbenchProjectOptionSchema,
  }).strict()).optional(),
}).strict();
const summary = z.object({
  counts: WorkbenchProjectThreadSummaryCountsSchema,
  lastThreadUpdateAt: z.number().nullable(),
  pinnedThreads: z.array(z.object({
    location: ProjectLocationReferenceSchema, entry: WorkbenchPinnedThreadSummaryEntrySchema,
  }).strict()),
  unsettledThreads: z.array(z.object({
    location: ProjectLocationReferenceSchema, entry: WorkbenchProjectThreadSummaryEntrySchema,
  }).strict()),
}).strict();
const sourceQuery = z.object({
  daemonId: DaemonIdSchema, phase: WorkspaceSourcePhaseSchema, failure,
}).strict();

export const WorkspaceProjectsSchema = z.object({
  projects: z.array(logicalProject),
  observedProjects: z.array(z.object({
    identityKey: ProjectIdentityKeySchema,
    locations: z.array(z.object({
      location: ProjectLocationReferenceSchema,
      hostname: z.string(),
      project: WorkbenchProjectOptionSchema,
    }).strict()),
    registrationFailure: failure,
  }).strict()),
  summaries: z.record(z.string(), summary),
  sources: z.array(WorkspaceDaemonFactSchema),
  catalogues: z.array(sourceQuery).default([]),
  navigation: z.array(sourceQuery).default([]),
}).strict();
export type WorkspaceProjects = z.infer<typeof WorkspaceProjectsSchema>;

export const WorkspaceProjectGroupsSchema = z.object({
  orderedProjectIds: z.array(LogicalProjectIdSchema),
  unsettledProjectIds: z.array(LogicalProjectIdSchema),
  unarchivedProjectIds: z.array(LogicalProjectIdSchema),
}).strict();
export type WorkspaceProjectGroups = z.infer<typeof WorkspaceProjectGroupsSchema>;

const WorkspaceThreadRowSchema = z.object({
  logicalProjectId: LogicalProjectIdSchema.nullable(),
  location: ProjectLocationReferenceSchema,
  hostname: z.string(),
  rootPath: z.string(),
  entry: WorkbenchThreadSidebarRowSchema,
  observedOnly: z.boolean().optional(),
}).strict();
const WorkspaceThreadRowProjectSchema = z.object({
  location: ProjectLocationReferenceSchema,
  phase: WorkspaceSourcePhaseSchema,
  failure,
  archivedCount: z.number().int().nonnegative().optional(),
}).strict();
export const WorkspaceThreadRowsSchema = z.object({
  rows: z.array(WorkspaceThreadRowSchema),
  projects: z.array(WorkspaceThreadRowProjectSchema),
}).strict();
export type WorkspaceThreadRows = z.infer<typeof WorkspaceThreadRowsSchema>;
export type WorkspaceThreadRow = WorkspaceThreadRows["rows"][number];
export const WorkspaceArchivedThreadsSchema = z.object({
  rows: z.array(WorkspaceThreadRowSchema),
  projects: z.array(WorkspaceThreadRowProjectSchema.omit({ archivedCount: true }).extend({ total: z.number().int().nonnegative() }).strict()),
}).strict();
export type WorkspaceArchivedThreads = z.infer<typeof WorkspaceArchivedThreadsSchema>;
/** Stable identity of an app thread row across delta hops. */
export const workspaceThreadRowKey = (row: Pick<WorkspaceThreadRow, "logicalProjectId" | "location" | "entry">) =>
  `${row.logicalProjectId ?? "observed"}/${row.location.daemonId}/${row.location.projectId}/${sidebarRowKey(row.entry)}`;

/** One thread's summary with where it lives; null while its owner or summary is unknown. */
export const WorkspaceThreadSummarySchema = z.object({
  location: ProjectLocationReferenceSchema,
  logicalProjectId: LogicalProjectIdSchema.nullable(),
  summary: ThreadSummarySchema,
}).strict();
export type WorkspaceThreadSummary = z.infer<typeof WorkspaceThreadSummarySchema>;
export const WorkspaceThreadSummariesSchema = z.record(z.string().min(1), WorkspaceThreadSummarySchema.nullable());
export type WorkspaceThreadSummaries = z.infer<typeof WorkspaceThreadSummariesSchema>;

export const WorkspaceThreadOwnerSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("current"), identity: WorkbenchThreadIdentityResolutionSchema,
    location: ProjectLocationReferenceSchema,
    logicalProjectId: LogicalProjectIdSchema.nullable(),
  }).strict(),
  z.object({
    phase: z.enum(["pending", "unavailable", "conflict"]), failure,
  }).strict(),
]);
export type WorkspaceThreadOwner = z.infer<typeof WorkspaceThreadOwnerSchema>;

const appState = z.custom<WorkbenchClientStateResponse>(value =>
  conformWorkbenchClientStateResponse(value).success);
const runtime = z.object({
  frontendGeneration: z.object({ javascript: z.string(), stylesheet: z.string() }).nullable(),
  reloadDirt: z.object({
    dirtyScopes: z.array(z.object({
      dependantScopes: z.array(z.string()),
      description: z.string(),
      destructive: z.boolean(),
      scope: z.string(),
    }).strict()),
    error: failure,
    pendingScopes: z.array(z.string()),
  }).strict(),
}).strict();

export const WorkspaceObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("search"), data: WorkspaceSearchResponseSchema,
    sources: z.array(z.object({
      daemonId: DaemonIdSchema, projectId: ProjectIdSchema.nullable(),
      phase: WorkspaceSourcePhaseSchema, failure,
    }).strict()) }).strict(),
  z.object({ ...envelope, kind: z.literal("daemonRuntime"), daemonId: DaemonIdSchema.nullable(),
    data: WorkbenchDaemonReloadDirtEnvelopeSchema.shape.snapshot.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("daemonUpdate"), daemonId: DaemonIdSchema.nullable(),
    data: InstallationUpdateSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("network"), data: WorkbenchNetworkSnapshotSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("projects"), data: WorkspaceProjectsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("projectGroups"), data: WorkspaceProjectGroupsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("projectThreads"), data: WorkspaceThreadRowsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("projectTree"), sourceGeneration: revision.default(0),
    data: WorkbenchProjectStateUpdateSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("workingTreeSummary"), data: WorkingTreeSummarySchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("accountLimits"), data: WorkbenchAccountLimitsSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("threadOwner"), data: WorkspaceThreadOwnerSchema }).strict(),
  z.object({
    ...envelope, kind: z.literal("thread"), owner: WorkspaceThreadOwnerSchema,
    data: WorkbenchThreadObservationSnapshotSchema.nullable(),
    runtime: ThreadRuntimeRecordSchema.default({}),
  }).strict(),
  z.object({ ...envelope, kind: z.literal("presentation"), data: PresentationSnapshotSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("appState"), data: appState.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("runtime"), data: runtime.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("reloadOperation"), data: WorkbenchReloadOperationSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("stats"), ...statsObservation }).strict(),
  z.object({ ...envelope, kind: z.literal("archivedThreads"), data: WorkspaceArchivedThreadsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("threadVis"), data: VisThreadSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("visSnapshot"), data: VisSnapshotSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("threadSummaries"), data: WorkspaceThreadSummariesSchema }).strict(),
]);
export type WorkspaceObservation = z.infer<typeof WorkspaceObservationSchema>;

/** A keyed delta onto exactly `baseRevision` of one observation; gaps force a fresh full value. */
export const WorkspaceObservationDeltaSchema = z.object({
  subscriptionId: z.uuid(),
  generation: revision,
  kind: z.string().min(1).max(64),
  baseRevision: revision,
  revision,
  delta: ObservationDeltaSchema,
}).strict();
export type WorkspaceObservationDelta = z.infer<typeof WorkspaceObservationDeltaSchema>;

// A busy arc lists hundreds of claimed paths and proposals, once at the top and again per member; they decompose so
// one claim or proposal change ships only itself. Inner items stay loose: every patch revalidates the whole entry.
const pathList = observationShape.keyed((path: string) => path, z.string().min(1));
const gitArcProposals = observationShape.keyed(
  (proposal: { proposalId: string; rootId?: string }) => `${proposal.rootId ?? ""}/${proposal.proposalId}`, z.json());
const gitArcMemberKey = (member: { harness: string; threadId: string }) => `${member.harness}:${member.threadId}`;
const gitArcShape = observationShape.object({ fields: {
  claimedPaths: pathList, stashedPaths: pathList, proposals: gitArcProposals,
  members: observationShape.keyed(gitArcMemberKey, z.json(), {
    fields: { claimedPaths: pathList, stashedPaths: pathList, proposals: gitArcProposals },
  }),
} });
const gitArcPlanShape = observationShape.object({ fields: {
  scopePaths: pathList,
  members: observationShape.keyed(gitArcMemberKey, z.json(), { fields: { scopePaths: pathList } }),
} });
// Questionnaire history only grows, and a long-lived thread's history reaches hundreds of KB.
const entryFields = {
  gitArc: gitArcShape, gitArcPlan: gitArcPlanShape,
  questionnaireHistory: observationShape.keyed((entry: { requestKey: string }) => entry.requestKey, z.json()),
};
const entryShape: ObservationShape = { fields: entryFields };
// Thread-state revision counters bump on background passes with no visible change; they ride along only with real changes.
const sidebarRowsShape = observationShape.object({
  schema: WorkbenchThreadSidebarRowSnapshotSchema, incidental: ["revision"],
  fields: { entries: observationShape.keyed(sidebarRowKey, WorkbenchThreadSidebarRowSchema, entryShape) },
});
const entriesShape = (schema: z.ZodObject) => observationShape.object({
  schema, incidental: ["revision"],
  fields: { entries: observationShape.keyed(sidebarRowKey, WorkbenchThreadSidebarEntrySchema, entryShape) },
});
const catalogueShape = observationShape.object({
  // The payload schema is a transform, so the whole catalogue is validated after a delta applies.
  validate: WorkbenchProjectsPayloadSchema,
  fields: { data: observationShape.keyed((project: { id: string }) => project.id, WorkbenchProjectOptionSchema) },
});
const locationsShape = observationShape.object({
  schema: WorkbenchProjectLocationsPayloadSchema,
  fields: { data: observationShape.keyed((location: { project: { id: string } }) => location.project.id,
    WorkbenchProjectLocationsPayloadSchema.shape.data.element) },
});
// A large project's tree is hundreds of KB while git change counts churn constantly; both decompose, so a count
// tick ships one record entry and a new file ships one node under its folder.
const projectTreeNodeShape: ObservationShape = { schema: WorkbenchProjectTreeNodeFieldsSchema };
const projectTreeNodes = observationShape.keyed((node: { path: string }) => node.path, WorkbenchProjectTreeNodeSchema, projectTreeNodeShape);
projectTreeNodeShape.fields = { children: projectTreeNodes };
const projectTreeShape = observationShape.object({
  schema: WorkbenchProjectStateUpdateSchema,
  fields: { snapshot: observationShape.object({
    schema: WorkbenchProjectSnapshotSchema,
    fields: { changes: observationShape.record(WorkbenchProjectSnapshotSchema.shape.changes.valueType), tree: projectTreeNodes },
  }) },
});
const byProject = <Item extends { projectId: string }>(item: z.ZodType, shape?: ObservationShape) =>
  observationShape.keyed((value: Item) => value.projectId, item, shape);
// A row's entry decomposes too, so an activity tick ships its changed fields instead of the whole entry.
const threadRowShape: ObservationShape = {
  schema: WorkspaceThreadRowSchema,
  fields: { entry: observationShape.object({ validate: WorkbenchThreadSidebarRowSchema, fields: entryFields }) },
};
const rowsShape = (schema: z.ZodObject, project: z.ZodType) => observationShape.object({
  schema,
  fields: {
    rows: observationShape.keyed(workspaceThreadRowKey, WorkspaceThreadRowSchema, threadRowShape),
    projects: observationShape.keyed((item: { location: { daemonId: string; projectId: string } }) =>
      `${item.location.daemonId}/${item.location.projectId}`, project),
  },
});
const threadObservationObject: z.ZodObject = WorkbenchThreadObservationSnapshotSchema;
// A token-usage tick ships one thread's changed runtime field.
const runtimeShape = observationShape.record(ThreadRuntimeSchema, { schema: ThreadRuntimeSchema });
type SummaryEntry = { entryKind?: string; draftId?: string; identity?: { harness: string; threadId: string } };
const summaryEntryKey = (entry: SummaryEntry) => entry.identity
  ? `${entry.identity.harness}:${entry.identity.threadId}` : `draft:${entry.draftId ?? ""}`;
const locatedSummaryKey = (item: { location: { daemonId: string; projectId: string }; entry: SummaryEntry }) =>
  `${item.location.daemonId}/${item.location.projectId}/${summaryEntryKey(item.entry)}`;

function memberSchema<Union extends { options: readonly z.ZodObject[] }>(union: Union, kind: string) {
  const member = union.options.find(option => (option.shape.kind as z.ZodLiteral<string>).value === kind);
  if (!member) throw new Error(`Unknown observation kind ${kind}.`);
  return member;
}

/**
 * How each observation decomposes for deltas. Kinds without extra fields still diff field-by-field;
 * keyed collections keep churny lists (rows, entries, projects) at one item per change.
 */
const daemonShapes = new Map<string, ObservationShape>();
const workspaceShapes = new Map<string, ObservationShape>();

export function daemonObservationShape(kind: DaemonWorkspaceObservation["kind"]): ObservationShape {
  let shape = daemonShapes.get(kind);
  if (!shape) daemonShapes.set(kind, shape = buildDaemonObservationShape(kind));
  return shape;
}

export function workspaceObservationShape(kind: WorkspaceObservation["kind"]): ObservationShape {
  let shape = workspaceShapes.get(kind);
  if (!shape) workspaceShapes.set(kind, shape = buildWorkspaceObservationShape(kind));
  return shape;
}

// Startup resolves projects one at a time; each step drops one pending id instead of resending the shrinking list.
const pendingProjectIds = observationShape.keyed((projectId: string) => projectId, ProjectIdSchema);

function buildDaemonObservationShape(kind: DaemonWorkspaceObservation["kind"]): ObservationShape {
  const schema = memberSchema(DaemonWorkspaceObservationSchema, kind);
  switch (kind) {
    case "projectThreads": return { schema, fields: {
      projects: byProject(projectRows, { schema: projectRows, fields: { sidebar: sidebarRowsShape } }),
    } };
    case "summaries": return { schema, fields: {
      pendingProjectIds,
      projects: byProject(WorkbenchProjectThreadSummarySchema, { schema: WorkbenchProjectThreadSummarySchema, incidental: ["revision"],
        fields: {
          unsettledThreads: observationShape.keyed(summaryEntryKey, WorkbenchProjectThreadSummaryEntrySchema),
          pinnedThreads: observationShape.keyed(summaryEntryKey, WorkbenchPinnedThreadSummaryEntrySchema, entryShape),
        } }),
    } };
    case "catalogue": return { schema, fields: { catalogue: catalogueShape, locations: locationsShape } };
    case "projectPlacement": return { schema, fields: {
      pendingProjectIds,
      projects: byProject(z.object({ projectId: ProjectIdSchema, hasUnarchivedWork: z.boolean() }).strict()),
    } };
    case "archivedThreads": return { schema, fields: {
      projects: byProject(archivedProject, { schema: archivedProject, fields: {
        rows: observationShape.keyed(sidebarRowKey, WorkbenchThreadSidebarRowSchema, entryShape),
      } }),
    } };
    case "thread": return { schema, fields: { data: entriesShape(threadObservationObject), runtime: runtimeShape } };
    case "projectTree": return { schema, fields: { project: projectTreeShape } };
    case "threadVis": return { schema, fields: { data: visThreadShape } };
    // A retarget adds and removes whole threads; one thread's change ships only its changed fields.
    case "threadSummaries": return { schema, fields: { summaries: observationShape.record(LocatedThreadSummarySchema.nullable(), {
      fields: { summary: observationShape.object(threadSummaryShape) },
    }) } };
    default: return { schema };
  }
}

const threadSummaryShape: ObservationShape = {
  fields: { row: observationShape.object({ validate: WorkbenchThreadSidebarRowSchema, fields: entryFields }) },
};

function buildWorkspaceObservationShape(kind: WorkspaceObservation["kind"]): ObservationShape {
  const schema = memberSchema(WorkspaceObservationSchema, kind);
  switch (kind) {
    case "projectThreads": return { schema, fields: { data: rowsShape(WorkspaceThreadRowsSchema, WorkspaceThreadRowProjectSchema) } };
    case "archivedThreads": return { schema, fields: {
      data: rowsShape(WorkspaceArchivedThreadsSchema, WorkspaceArchivedThreadsSchema.shape.projects.element),
    } };
    case "projects": return { schema, fields: { data: observationShape.object({
      schema: WorkspaceProjectsSchema,
      fields: {
        projects: observationShape.keyed((project: { id: string }) => project.id, logicalProject),
        summaries: observationShape.record(summary, { fields: {
          unsettledThreads: observationShape.keyed(locatedSummaryKey, summary.shape.unsettledThreads.element),
          pinnedThreads: observationShape.keyed(locatedSummaryKey, summary.shape.pinnedThreads.element, {
            fields: { entry: observationShape.object({ fields: entryFields }) },
          }),
        } }),
      },
    }) } };
    case "thread": return { schema, fields: { data: entriesShape(threadObservationObject), runtime: runtimeShape } };
    case "appState": return { schema, fields: { data: appStateShape() } };
    case "projectTree": return { schema, fields: { data: projectTreeShape } };
    case "threadVis": return { schema, fields: { data: visThreadShape } };
    case "threadSummaries": return { schema, fields: { data: observationShape.record(WorkspaceThreadSummarySchema.nullable(), {
      fields: { summary: observationShape.object(threadSummaryShape) },
    }) } };
    default: return { schema };
  }
}

// A rendering flag flip ships one session's field, not every session's whole document.
const visThreadShape = observationShape.object({
  schema: VisThreadSchema,
  fields: { sessions: observationShape.keyed((session: VisLiveSession) => session.sessionId, VisThreadSchema.shape.sessions.element) },
});

/** App state rows key by their table's primary key, so one draft or preference write ships one row. */
function appStateShape() {
  const row = z.record(z.string(), z.json());
  const rows = Object.fromEntries(Object.entries(appStateClientTables).map(([name, table]) => {
    const columns = tablePrimaryKeyColumns(table);
    // Key serialization only; rows compare structurally inside the delta engine.
    return [name, observationShape.keyed((item: Record<string, unknown>) => JSON.stringify(columns.map(column => item[column])), row)];
  }));
  // `revision` is not incidental: a newer snapshot fences acknowledged rows a coalesced read never saw.
  return observationShape.object({ validate: appState, fields: { rows: observationShape.object({ fields: rows }) } });
}

export const WorkspaceObserveSchema = z.object({
  subscriptionId: z.uuid(),
  generation: revision,
  query: WorkspaceQuerySchema,
}).strict();
export type WorkspaceObserve = z.infer<typeof WorkspaceObserveSchema>;
