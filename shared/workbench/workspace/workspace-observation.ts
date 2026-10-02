/*
 * Exports:
 * - WorkspaceSourcePhaseSchema/WorkspaceSourcePhase: independently observed source freshness.
 * - WorkspaceTranscriptStateSchema/WorkspaceTranscriptState: caller-local transcript subscription freshness.
 * - DaemonWorkspaceQuerySchema/DaemonWorkspaceQuery: demanded daemon facts, independent of socket selection.
 * - DaemonWorkspaceObserveSchema/DaemonWorkspaceObserve: named daemon observation arguments.
 * - DaemonWorkspaceObservationSchema/DaemonWorkspaceObservation: versioned partial daemon results.
 * - WorkspaceProjectReferenceSchema/WorkspaceProjectReference: registered project or explicit observed location.
 * - WorkspaceQuerySchema/WorkspaceQuery: browser workspace intents without transport destinations.
 * - WorkspaceDaemonFactSchema/WorkspaceDaemonFact: app-owned daemon connection facts.
 * - WorkspaceProjectsSchema/WorkspaceProjects: merged and not-yet-registered projects.
 * - WorkspaceProjectGroupsSchema/WorkspaceProjectGroups: app-owned cross-daemon sidebar project pools.
 * - WorkspaceThreadRowsSchema/WorkspaceThreadRows: source-qualified selected thread rows.
 * - WorkspaceThreadOwnerSchema/WorkspaceThreadOwner: resolved ownership or a scoped unresolved result.
 * - WorkspaceObservationSchema/WorkspaceObservation: independently revisioned app query results.
 * - WorkspaceObserveSchema/WorkspaceObserve: replace one named observation's arguments.
 * - WorkspaceReleaseSchema: release only the matching observation generation.
 * - WORKSPACE_OBSERVE_METHOD/WORKSPACE_RELEASE_METHOD/WORKSPACE_UPDATED_METHOD: shared observation protocol.
 */
import { z } from "zod";
import {
  DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ProjectIdentityKeySchema,
  ThreadReferenceSchema,
} from "../identity";
import {
  WorkbenchProjectStateUpdateSchema, WorkbenchProjectsPayloadSchema, WorkbenchProjectOptionSchema,
} from "../project/project-state";
import {
  ProjectLocationReferenceSchema, WorkbenchProjectLocationsPayloadSchema,
} from "../project/project-location";
import {
  WorkbenchProjectThreadSummarySchema, WorkbenchThreadSidebarEntrySchema,
  WorkbenchThreadSidebarSnapshotSchema, WorkbenchThreadObservationSnapshotSchema,
  WorkbenchProjectThreadSummaryCountsSchema, WorkbenchPinnedThreadSummaryEntrySchema,
  WorkbenchProjectThreadSummaryEntrySchema,
} from "../thread/thread-state";
import { WorkbenchThreadIdentityResolutionSchema } from "../thread/workbench-thread-identity";
import { PresentationSnapshotSchema } from "../../state/workbench-presentation-state";
import type { WorkbenchClientStateResponse } from "../../state/workbench-client-state";
import { conformWorkbenchClientStateResponse } from "../../state/workbench-client-state-conformance";
import { WorkbenchNetworkSnapshotSchema } from "../../http/workbench-network";
import { WorkbenchDaemonReloadDirtEnvelopeSchema } from "../daemon-reload";
import { WorkbenchSearchRequestSchema } from "../search/workbench-search";
import { WorkspaceSearchResponseSchema } from "./workspace-commands";
import { WorkbenchStatsReadRequestSchema } from "../stats/workbench-stats-contract";
import { WorkbenchStatsObservedResponseSchema } from "../stats/workbench-stats-conformance";

export const WORKSPACE_OBSERVE_METHOD = "workspace/observe";
export const WORKSPACE_RELEASE_METHOD = "workspace/release";
export const WORKSPACE_UPDATED_METHOD = "workspace/updated";

export const WorkspaceSourcePhaseSchema = z.enum(["pending", "current", "stale", "failed", "unavailable"]);
export type WorkspaceSourcePhase = z.infer<typeof WorkspaceSourcePhaseSchema>;
const failure = z.string().max(512).nullable();
export const WorkspaceTranscriptStateSchema = z.object({
  subscriptionId: z.string().min(1).max(256), phase: WorkspaceSourcePhaseSchema, failure,
}).strict();
export type WorkspaceTranscriptState = z.infer<typeof WorkspaceTranscriptStateSchema>;
const revision = z.number().int().nonnegative();
const envelope = {
  subscriptionId: z.uuid(),
  generation: revision,
  revision,
  phase: WorkspaceSourcePhaseSchema,
  failure,
};

export const DaemonWorkspaceQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtime") }).strict(),
  z.object({ kind: z.literal("catalogue") }).strict(),
  z.object({ kind: z.literal("summaries") }).strict(),
  z.object({ kind: z.literal("projectPlacement") }).strict(),
  z.object({ kind: z.literal("projectThreads"), projectIds: z.array(ProjectIdSchema) }).strict(),
  z.object({ kind: z.literal("projectTree"), projectId: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("threadIdentity"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("thread"), projectId: ProjectIdSchema, threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("stats"), request: WorkbenchStatsReadRequestSchema }).strict(),
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

/** Usage arrives first; claim hotspots stay pending until rename history has been merged. */
const statsObservation = {
  claimsPhase: WorkspaceSourcePhaseSchema,
  data: WorkbenchStatsObservedResponseSchema.nullable(),
};

const projectRows = z.object({
  projectId: ProjectIdSchema,
  phase: WorkspaceSourcePhaseSchema,
  failure,
  sidebar: WorkbenchThreadSidebarSnapshotSchema.nullable(),
}).strict();

export const DaemonWorkspaceObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("runtime"), data: WorkbenchDaemonReloadDirtEnvelopeSchema.shape.snapshot }).strict(),
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
    ...envelope, kind: z.literal("threadIdentity"), identity: WorkbenchThreadIdentityResolutionSchema.nullable(),
  }).strict(),
  z.object({
    ...envelope, kind: z.literal("thread"), data: WorkbenchThreadObservationSnapshotSchema.nullable(),
  }).strict(),
  z.object({ ...envelope, kind: z.literal("stats"), ...statsObservation }).strict(),
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
  z.object({ kind: z.literal("network") }).strict(),
  z.object({ kind: z.literal("projects"), daemonIds: z.array(DaemonIdSchema).optional() }).strict(),
  z.object({ kind: z.literal("projectGroups") }).strict(),
  z.object({
    kind: z.literal("projectThreads"),
    projects: z.array(WorkspaceProjectReferenceSchema).nullable(),
  }).strict(),
  z.object({ kind: z.literal("projectTree"), location: ProjectLocationReferenceSchema }).strict(),
  z.object({ kind: z.literal("threadOwner"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("thread"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("presentation") }).strict(),
  z.object({
    kind: z.literal("appState"), browserStateId: z.uuid().nullable(),
    schemaVersion: revision.optional(),
  }).strict(),
  z.object({ kind: z.literal("runtime") }).strict(),
  z.object({ kind: z.literal("stats"), daemonId: DaemonIdSchema, request: WorkbenchStatsReadRequestSchema }).strict(),
]);
export type WorkspaceQuery = z.infer<typeof WorkspaceQuerySchema>;

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

export const WorkspaceThreadRowsSchema = z.object({
  rows: z.array(z.object({
    logicalProjectId: LogicalProjectIdSchema.nullable(),
    location: ProjectLocationReferenceSchema,
    hostname: z.string(),
    rootPath: z.string(),
    entry: WorkbenchThreadSidebarEntrySchema,
    observedOnly: z.boolean().optional(),
  }).strict()),
  projects: z.array(z.object({
    location: ProjectLocationReferenceSchema,
    phase: WorkspaceSourcePhaseSchema,
    failure,
  }).strict()),
}).strict();
export type WorkspaceThreadRows = z.infer<typeof WorkspaceThreadRowsSchema>;

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
  z.object({ ...envelope, kind: z.literal("network"), data: WorkbenchNetworkSnapshotSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("projects"), data: WorkspaceProjectsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("projectGroups"), data: WorkspaceProjectGroupsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("projectThreads"), data: WorkspaceThreadRowsSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("projectTree"), sourceGeneration: revision.default(0),
    data: WorkbenchProjectStateUpdateSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("threadOwner"), data: WorkspaceThreadOwnerSchema }).strict(),
  z.object({
    ...envelope, kind: z.literal("thread"), owner: WorkspaceThreadOwnerSchema,
    data: WorkbenchThreadObservationSnapshotSchema.nullable(),
  }).strict(),
  z.object({ ...envelope, kind: z.literal("presentation"), data: PresentationSnapshotSchema.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("appState"), data: appState.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("runtime"), data: runtime.nullable() }).strict(),
  z.object({ ...envelope, kind: z.literal("stats"), ...statsObservation }).strict(),
]);
export type WorkspaceObservation = z.infer<typeof WorkspaceObservationSchema>;

export const WorkspaceObserveSchema = z.object({
  subscriptionId: z.uuid(),
  generation: revision,
  query: WorkspaceQuerySchema,
}).strict();
export type WorkspaceObserve = z.infer<typeof WorkspaceObserveSchema>;
