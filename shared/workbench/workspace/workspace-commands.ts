/*
 * Exports:
 * - workspaceCommandRoutes: semantic operation ownership, shared by app routing and client facades.
 * - WorkspaceCommandMethod/WorkspaceCommand/WorkspaceCommandResult: domain-typed workspace commands.
 * - WorkspaceCommandSchema: closed method registry and bounded JSON edge validation before owner validation.
 * - WORKSPACE_COMMAND_NOT_SENT/WORKSPACE_COMMAND_UNCERTAIN: distinguish dispatch outcomes.
 * - WorkspaceThreadMutation/WorkspaceThreadMutationSchema: admitted thread state operations.
 * - WorkspaceThreadActionSchema: identity-addressed user actions.
 * - WorkspaceThreadActionResult/WorkspaceThreadActionResultSchema: app result for thread actions.
 * - WorkspaceDraftLaunchSchema: saved-draft launch intent.
 * - WorkspaceLayoutRequest/WorkspaceLayoutRequestSchema: app-owned layout edits.
 * - WorkspaceHomeLayoutIntent/WorkspaceHomeLayoutIntentSchema: home row or project-folder move intent.
 * - WorkspaceTranscriptRequestSchema: typed transcript read and stream operations.
 * - WorkspaceSearchResponseSchema: source-qualified search results and partial failure.
 */
import { z } from "zod";
import type { WorkbenchDaemonRequestMap, WorkbenchDaemonMethod } from "../daemon/workbench-daemon-requests";
import { ProjectLocationReferenceSchema } from "../project/project-location";
import { DaemonIdSchema, ThreadReferenceSchema, LogicalProjectIdSchema, ThreadDisplayKeySchema } from "../identity";
import { WorkbenchThreadStateRequestSchema, WorkbenchHomeThreadDisplayOrderSchema, type WorkbenchThreadStateRequest } from "../thread/thread-state";
import { WorkbenchThreadDisplayOrderSchema } from "../thread/thread-display-order";
import { WorkbenchMessageContextSchema } from "../provider/provider-input";
import { WorkbenchSearchResultSchema } from "../search/workbench-search";
import {
  workbenchTranscriptOperations,
  type WorkbenchTranscriptReadRequest, type WorkbenchTranscriptSubscribeParams,
  type WorkbenchTranscriptUnsubscribeParams,
  type WorkbenchTranscriptConformanceReport,
} from "../database/transcript/workbench-transcript-contract";

export const WORKSPACE_COMMAND_NOT_SENT = -32012;
export const WORKSPACE_COMMAND_UNCERTAIN = -32013;

export const workspaceCommandRoutes = {
  "project/catalog/read": "installation",
  "project/tree/refresh": "folder",
  "project/entry/create": "folder",
  "project/file/delete": "folder",
  "questionnaires/pending/read": "installation",
  "thread/questionnaires/read": "thread",
  "thread/steers/read": "thread",
  "thread/browse/read": "thread",
  "thread/approvals/read": "thread",
  "thread/metadata/read": "thread",
  "thread/page/read": "thread",
  "thread/reconcile": "thread",
  "thread/message/submit": "thread",
  "thread/title/set": "thread",
  "thread/compact": "thread",
  "thread/provider/delete": "thread",
  "thread/stop": "thread",
  "thread/interrupt": "thread",
  "thread/goal/read": "thread",
  "thread/goal/update": "thread",
  "thread/goal/remove": "thread",
  "thread/skills/read": "thread",
  "thread/skills/deactivate": "thread",
  "voice/configuration/read": "installation",
  "voice/configuration/write": "installation",
  "voice/agents": "installation",
  "voice/prepare": "installation",
  "voice/start": "installation",
  "voice/audio": "session",
  "voice/finish": "session",
  "voice/cancel": "session",
  "repo/runtime/read": "installation",
  "git/working-tree/read": "folder",
  "git/working-tree/diff": "folder",
  "git/working-tree/preview": "folder",
  "git/working-tree/mutate": "folder",
  "models/context/read": "installation",
  "models/list": "installation",
  "account/limits/read": "installation",
  "agents/list": "folder",
  "agents/read": "folder",
  "browse/sessions/forget": "thread",
  "browse/sessions/read": "thread",
  "browse/sessions/stop": "thread",
  "sandbox-network/read": "installation",
  "sandbox-network/update": "installation",
  "command-approvals/read": "installation",
  "command-approvals/remove": "installation",
  "command-approvals/patch": "installation",
  "project/discovery-settings/read": "installation",
  "project/discovery-settings/update": "installation",
  "project/folders/list": "installation",
  "project/create": "installation",
  "local-capabilities/read": "installation",
  "local-capabilities/update": "installation",
  "native/file/link-roots": "folder",
  "native/file/open": "folder",
  "native/file/reveal": "folder",
  "profiles/delete": "installation",
  "profiles/read": "installation",
  "profiles/target/read": "installation",
  "profiles/target/set": "installation",
  "profiles/upsert": "installation",
  "project/file-index/read": "folder",
  "project/file/read": "folder",
  "project/file/reset": "folder",
  "project/file/save": "folder",
  "project/store/read": "folder",
  "project/store/update": "folder",
  "search/query": "folder",
  "questionnaire/respond": "thread",
  "stats/import/start": "installation",
  "stats/rate-limits/refresh": "installation",
  "skills/read": "folder",
  "git/arc/compare": "thread",
  "git/arc/diff-artifact/read": "thread",
  "git/arc/proposal/commit": "thread",
  "git/arc/proposal/read": "thread",
  "git/arc/release": "thread",
  "git/arc/remove": "thread",
  "git/arc/restore": "thread",
  "git/arc/stash": "thread",
  "git/arc/unstash": "thread",
  "git/arc/stash/discard": "thread",
} as const satisfies Partial<Record<WorkbenchDaemonMethod, "thread" | "folder" | "installation" | "session">>;

export type WorkspaceCommandMethod = keyof typeof workspaceCommandRoutes;
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: ThreadReferenceSchema }).strict(),
  z.object({ kind: z.literal("folder"), location: ProjectLocationReferenceSchema }).strict(),
  z.object({ kind: z.literal("installation"), daemonId: DaemonIdSchema.optional() }).strict(),
]);
export const WorkspaceCommandSchema = z.object({
  method: z.enum(Object.keys(workspaceCommandRoutes) as [WorkspaceCommandMethod, ...WorkspaceCommandMethod[]]),
  scope: scope.optional(),
  params: z.record(z.string(), z.json()),
}).strict().superRefine((value, ctx) => {
  const route = workspaceCommandRoutes[value.method];
  if (route === "thread" && (typeof value.params.threadId !== "string" || !value.params.threadId)) {
    ctx.addIssue({ code: "custom", path: ["params", "threadId"], message: "Thread command requires its identity." });
  }
  if (route === "folder" && value.scope?.kind !== "folder" && value.scope?.kind !== "thread") {
    ctx.addIssue({ code: "custom", path: ["scope"], message: "Folder command requires an app location." });
  }
  if (route === "session" && (typeof value.params.sessionId !== "string" || !value.params.sessionId)) {
    ctx.addIssue({ code: "custom", path: ["params", "sessionId"], message: "Session command requires its identity." });
  }
  if ((route === "thread" || route === "session") && value.scope) {
    ctx.addIssue({ code: "custom", path: ["scope"], message: "This command is routed by its identity, not a destination." });
  }
});
export type WorkspaceCommand<Method extends WorkspaceCommandMethod = WorkspaceCommandMethod> = {
  [Key in Method]: {
    method: Key;
    params: WorkbenchDaemonRequestMap[Key]["params"];
  } & (typeof workspaceCommandRoutes[Key] extends "folder"
    ? { scope: Extract<z.infer<typeof scope>, { kind: "folder" | "thread" }> }
    : typeof workspaceCommandRoutes[Key] extends "installation"
      ? { scope?: Extract<z.infer<typeof scope>, { kind: "installation" | "thread" }> }
      : { scope?: never });
}[Method];
export type WorkspaceCommandResult<Method extends WorkspaceCommandMethod> = WorkbenchDaemonRequestMap[Method]["result"];

const threadMutationMethods = [
  "workbench/thread-state/title/set", "workbench/thread-state/title/dismiss",
  "workbench/thread-state/pin/set", "workbench/thread-state/snooze/set", "workbench/thread-state/snooze/until",
  "workbench/thread-state/settle", "workbench/thread-state/restore", "workbench/thread-state/status/set",
  "workbench/thread-state/questionnaire/snooze",
  "workbench/thread-state/archive/set",
] as const;
export type WorkspaceThreadMutation = Extract<WorkbenchThreadStateRequest, { method: typeof threadMutationMethods[number] }>;
export const WorkspaceThreadMutationSchema = WorkbenchThreadStateRequestSchema
  .refine(value => threadMutationMethods.some(method => method === value.method), "Not a workspace thread mutation.")
  .transform(value => value as WorkspaceThreadMutation);

export const WorkspaceDraftLaunchSchema = z.object({
  draftId: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  context: WorkbenchMessageContextSchema.optional(),
  additionalWritableRoots: z.array(z.string().min(1)).optional(),
}).strict();

export const WorkspaceThreadActionSchema = z.object({
  threadId: z.uuid(),
  intent: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("priority"), priority: z.enum(["pinned", "main", "snoozed"]) }).strict(),
    z.object({ kind: z.literal("snoozeUntil"), targetThreadId: z.uuid() }).strict(),
    z.object({ kind: z.literal("pin"), pinned: z.boolean() }).strict(),
    z.object({ kind: z.literal("snooze"), snoozed: z.boolean() }).strict(),
    z.object({ kind: z.literal("archive"), archived: z.boolean() }).strict(),
    z.object({ kind: z.literal("status"), status: z.enum(["needsAttention", "completed", "stopped"]) }).strict(),
    z.object({ kind: z.literal("restore") }).strict(),
    z.object({ kind: z.literal("settle") }).strict(),
    z.object({
      kind: z.literal("stop"),
      requestKey: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
    }).strict(),
  ]),
}).strict();

export const WorkspaceThreadActionResultSchema = z.object({
  accepted: z.boolean(),
  // Daemon thread-state mutations report their revision; provider stop has none.
  revision: z.number().int().nonnegative().optional(),
}).strict();
export type WorkspaceThreadActionResult = z.infer<typeof WorkspaceThreadActionResultSchema>;

export const WorkspaceSearchResponseSchema = z.object({
  results: z.array(z.object({
    hit: WorkbenchSearchResultSchema,
    source: ProjectLocationReferenceSchema.optional(),
    logicalProjectId: LogicalProjectIdSchema.optional(),
  }).strict()).max(50),
  warning: z.string().max(512).optional(),
}).strict();

const layoutEdit = {
  move: z.object({
    kind: z.literal("move"), sourceKey: z.string().min(1),
    destinationFolderId: z.uuid().nullable(), beforeKey: z.string().min(1).nullable(),
  }).strict(),
  drop: z.object({
    kind: z.literal("drop"), sourceKey: z.string().min(1), targetKey: z.string().min(1),
    destinationFolderId: z.uuid().nullable(), folderId: z.uuid().optional(),
  }).strict(),
  rename: z.object({ kind: z.literal("rename"), folderId: z.uuid(), title: z.string().trim().min(1).max(80) }).strict(),
};
const section = z.enum(["pinned", "snoozed", "settled"]);
export const WorkspaceHomeLayoutIntentSchema = z.object({
  sourceKey: z.string().min(1), section,
  destinationFolderKey: z.string().min(1).nullable(), beforeKey: z.string().min(1).nullable(),
}).strict();
export type WorkspaceHomeLayoutIntent = z.infer<typeof WorkspaceHomeLayoutIntentSchema>;
const layoutRevision = { expectedRevision: z.number().int().nonnegative() };
export const WorkspaceLayoutRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...layoutRevision, action: z.literal("homeEdit"), intent: WorkspaceHomeLayoutIntentSchema }).strict(),
  z.object({ ...layoutRevision, action: z.literal("projectSave"),
    logicalProjectId: LogicalProjectIdSchema, order: WorkbenchThreadDisplayOrderSchema,
  }).strict(),
  z.object({ ...layoutRevision, action: z.literal("homeSave"), order: WorkbenchHomeThreadDisplayOrderSchema }).strict(),
  z.object({ ...layoutRevision, action: z.literal("pinnedSave"), order: WorkbenchThreadDisplayOrderSchema }).strict(),
  z.object({ ...layoutRevision, action: z.literal("projectAndHomeSave"),
    logicalProjectId: LogicalProjectIdSchema, order: WorkbenchThreadDisplayOrderSchema, homeOrder: WorkbenchHomeThreadDisplayOrderSchema,
  }).strict(),
  z.object({ ...layoutRevision, action: z.literal("projectEdit"), logicalProjectId: LogicalProjectIdSchema,
    intent: z.discriminatedUnion("kind", [
      layoutEdit.move.extend({ sourceKey: ThreadDisplayKeySchema, section }),
      layoutEdit.drop.extend({ sourceKey: ThreadDisplayKeySchema, targetKey: ThreadDisplayKeySchema, section }),
      layoutEdit.rename,
    ]),
    homeOrder: WorkbenchHomeThreadDisplayOrderSchema.optional(),
  }).strict(),
  z.object({ ...layoutRevision, action: z.literal("pinnedEdit"),
    intent: z.discriminatedUnion("kind", [layoutEdit.move, layoutEdit.drop, layoutEdit.rename]),
  }).strict(),
]);
export type WorkspaceLayoutRequest = z.infer<typeof WorkspaceLayoutRequestSchema>;

export const WorkspaceTranscriptRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("report"),
    params: z.custom<WorkbenchTranscriptConformanceReport>(value => workbenchTranscriptOperations.reportConformance.decodeParams(value).success),
  }).strict(),
  z.object({ kind: z.literal("read"),
    params: z.custom<WorkbenchTranscriptReadRequest>(value => workbenchTranscriptOperations.read.decodeParams(value).success),
  }).strict(),
  z.object({ kind: z.literal("subscribe"),
    params: z.custom<WorkbenchTranscriptSubscribeParams>(value => workbenchTranscriptOperations.subscribe.decodeParams(value).success),
  }).strict(),
  z.object({ kind: z.literal("unsubscribe"),
    params: z.custom<WorkbenchTranscriptUnsubscribeParams>(value => workbenchTranscriptOperations.unsubscribe.decodeParams(value).success),
  }).strict(),
]);
