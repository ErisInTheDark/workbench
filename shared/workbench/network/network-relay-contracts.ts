/*
 * Exports:
 * - RELAY_PRESENCE_METHOD/RELAY_REQUEST_METHOD/RELAY_RESULT_METHOD: app↔daemon relay notifications.
 * - RELAY_EXECUTE_METHOD: the daemon request an app sends to execute a relayed call on its target.
 * - RelayPresenceSchema/RelayPresence: which daemons an app reaches, and whether its connection is only standby.
 * - RelayResolveTargetSchema/RelayResolveTarget, RelayResolvedSchema/RelayResolved: an agent's target names and what an app resolved them to.
 * - RelayRemoteSummarySchema/RelayRemoteSummary: a reachable thread's summary located on its daemon.
 * - RelayRequestSchema/RelayRequest: what a daemon asks one app to do; RelayExecuteParamsSchema: what the app forwards to the target.
 * - RelayOutcomeSchema/RelayOutcome, RelayRequestNotificationSchema, RelayResultNotificationSchema: notification envelopes.
 * - relayResultSchemas: the answered result schema of each request kind.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "../identity";
import { GitPeerFetchOutcomeSchema, GitPeerFetchQuestionSchema } from "../git/git-peer-contracts";
import { LocatedThreadSummarySchema } from "../thread/thread-summary";
import { NetworkTargetSchema } from "./network-grants";
import { RemoteCallOutcomeSchema, RemoteCallSchema, RemoteCallerSchema } from "./network-remote-calls";

export const RELAY_PRESENCE_METHOD = "workbench/relay/presence";
export const RELAY_REQUEST_METHOD = "workbench/relay/request";
export const RELAY_RESULT_METHOD = "workbench/relay/result";
export const RELAY_EXECUTE_METHOD = "relay/execute";

export const RelayPresenceSchema = z.object({
  /** The receiving daemon's own identity, as the app's verified publication names it. */
  self: z.object({ daemonId: DaemonIdSchema, hostname: z.string().max(512) }).strict(),
  /** True while the app holds this connection only to relay; standby connections never keep a daemon awake. */
  standby: z.boolean(),
  daemons: z.array(z.object({ daemonId: DaemonIdSchema, hostname: z.string().max(512) }).strict()).max(256),
}).strict();
export type RelayPresence = z.infer<typeof RelayPresenceSchema>;

const address = z.string().trim().min(1).max(4096);
export const RelayResolveTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().trim().min(1).max(256) }).strict(),
  /** `<host>[:<folder>]` naming a folder of the caller's logical project. */
  z.object({ kind: z.literal("folder"), address, callerProjectId: ProjectIdSchema }).strict(),
  /** `<host>` for all-project `wb` feedback, `<host>:<folder>` for that folder's project feedback. */
  z.object({ kind: z.literal("feedback"), address, callerProjectId: ProjectIdSchema }).strict(),
]);
export type RelayResolveTarget = z.infer<typeof RelayResolveTargetSchema>;

export const RelayResolvedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), target: NetworkTargetSchema }).strict(),
  z.object({ kind: z.literal("failed"), failure: z.string().max(1024) }).strict(),
]);
export type RelayResolved = z.infer<typeof RelayResolvedSchema>;

export const RelayRemoteSummarySchema = LocatedThreadSummarySchema.extend({
  daemonId: DaemonIdSchema, hostname: z.string().max(512),
}).strict();
export type RelayRemoteSummary = z.infer<typeof RelayRemoteSummarySchema>;

export const RelayRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolve"), targets: z.array(RelayResolveTargetSchema).min(1).max(32) }).strict(),
  z.object({ kind: z.literal("summary"), threadIds: z.array(z.string().trim().min(1).max(256)).min(1).max(64) }).strict(),
  /** The caller's daemon and hostname are stamped by the app from the asking connection, never read from here. */
  z.object({
    kind: z.literal("execute"), targetDaemonId: DaemonIdSchema,
    caller: z.object({ threadId: WorkbenchThreadIdSchema, title: z.string().max(512) }).strict(), call: RemoteCallSchema,
  }).strict(),
  z.object({ kind: z.literal("gitPeerFetch"), question: GitPeerFetchQuestionSchema }).strict(),
]);
export type RelayRequest = z.infer<typeof RelayRequestSchema>;

export const relayResultSchemas = {
  resolve: z.object({ targets: z.array(RelayResolvedSchema) }).strict(),
  summary: z.object({ summaries: z.record(z.string(), RelayRemoteSummarySchema.nullable()) }).strict(),
  execute: RemoteCallOutcomeSchema,
  gitPeerFetch: GitPeerFetchOutcomeSchema,
} as const;

export const RelayExecuteParamsSchema = z.object({ caller: RemoteCallerSchema, call: RemoteCallSchema }).strict();
export type RelayExecuteParams = z.infer<typeof RelayExecuteParamsSchema>;

/**
 * `accepted` stops the acknowledgement deadline; `unreachable` lets the daemon ask another app because nothing was
 * dispatched; `answered` and `failed` are final. A request is never dispatched twice.
 */
export const RelayOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted") }).strict(),
  z.object({ kind: z.literal("unreachable"), failure: z.string().max(1024) }).strict(),
  z.object({ kind: z.literal("answered"), result: z.json() }).strict(),
  z.object({ kind: z.literal("failed"), failure: z.string().max(4096) }).strict(),
]);
export type RelayOutcome = z.infer<typeof RelayOutcomeSchema>;

export const RelayRequestNotificationSchema = z.object({
  method: z.literal(RELAY_REQUEST_METHOD),
  params: z.object({ requestId: z.uuid(), request: RelayRequestSchema }).strict(),
});
export const RelayResultNotificationSchema = z.object({
  method: z.literal(RELAY_RESULT_METHOD),
  params: z.object({ requestId: z.uuid(), outcome: RelayOutcomeSchema }).strict(),
});
export const RelayPresenceNotificationSchema = z.object({
  method: z.literal(RELAY_PRESENCE_METHOD),
  params: RelayPresenceSchema,
});
