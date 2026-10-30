/*
 * Exports:
 * - threadDaemonRequests: daemon requests for draft launches, presentation export, thread identity lookup, questionnaire answers,
 *   app-only relayed calls and network grants, and Browse sessions.
 * - WorkbenchQuestionnaireRespondRequest/WorkbenchQuestionnaireRespondResult: daemon-owned questionnaire answer contract.
 */
import { z } from "zod";
import type {
  WorkbenchBrowseSessionControlRequest,
  WorkbenchBrowseSessionControlResponse,
  WorkbenchBrowseSessionListRequest,
  WorkbenchBrowseSessionListResponse,
  WorkbenchHarness,
  WorkbenchUserInputResponse,
} from "../../../types.ts";
import type { WorkbenchUserInput } from "../../provider/provider-input.ts";
import { WorkbenchThreadLaunchStateSchema, type WorkbenchThreadLaunchRequest, type WorkbenchThreadLaunchState } from "../../thread/thread-launch.ts";
import {
  WorkbenchPresentationAttachmentChunkSchema,
  WorkbenchPresentationExportPageSchema,
  WorkbenchPresentationManifestPageSchema,
  type WorkbenchPresentationAttachmentChunk,
  type WorkbenchPresentationAttachmentChunkRequest,
  type WorkbenchPresentationExportPage,
  type WorkbenchPresentationExportRequest,
  type WorkbenchPresentationManifestPage,
  type WorkbenchPresentationManifestRequest,
} from "../../thread/thread-presentation-export.ts";
import {
  WorkbenchThreadIdentityResolutionSchema,
  type WorkbenchThreadIdentityResolution,
  type WorkbenchThreadIdentityResolveRequest,
} from "../../thread/workbench-thread-identity.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";
import {
  NetworkGrantSchema, type NetworkGrant, type NetworkGrantCreate, type NetworkGrantRevoke,
} from "../../network/network-grants.ts";
import { RELAY_EXECUTE_METHOD, type RelayExecuteParams } from "../../network/network-relay-contracts.ts";
import { RemoteCallOutcomeSchema, type RemoteCallOutcome } from "../../network/network-remote-calls.ts";

export interface WorkbenchQuestionnaireRespondRequest {
  activatedSkillPaths?: string[];
  harness?: WorkbenchHarness;
  insertAfterItemId?: string | null;
  insertAfterItemIndex?: number | null;
  projectId: string;
  requestKey: string;
  response: WorkbenchUserInputResponse;
  skipAutoCompact?: boolean;
  supplementalInput?: WorkbenchUserInput[];
  threadId: string;
  turnId?: string | null;
}

export interface WorkbenchQuestionnaireRespondResult {
  ok: true;
  route: "admitted" | "live" | "provider";
  warning?: string;
}

type BrowseSessionParams = Omit<WorkbenchBrowseSessionControlRequest, "action">;
const recordSchema = z.object({}).passthrough();

export const threadDaemonRequests = {
  // Browser creation uses saved-draft launch through the app server, not workspace commands.
  "thread/launch": defineDaemonRequest<WorkbenchThreadLaunchRequest, WorkbenchThreadLaunchState>()({
    route: "app", result: WorkbenchThreadLaunchStateSchema,
  }),
  "thread/launch/read": defineDaemonRequest<{ launchId: string }, { state: WorkbenchThreadLaunchState | null }>()({
    route: "app", result: z.object({ state: WorkbenchThreadLaunchStateSchema.nullable() }).strict(),
  }),
  // App-owned presentation exports.
  "thread/presentation/export": defineDaemonRequest<WorkbenchPresentationExportRequest, WorkbenchPresentationExportPage>()({
    route: "app", result: WorkbenchPresentationExportPageSchema,
  }),
  "thread/presentation/manifest/read": defineDaemonRequest<WorkbenchPresentationManifestRequest, WorkbenchPresentationManifestPage>()({
    route: "app", result: WorkbenchPresentationManifestPageSchema,
  }),
  "thread/presentation/attachment/read": defineDaemonRequest<WorkbenchPresentationAttachmentChunkRequest, WorkbenchPresentationAttachmentChunk>()({
    route: "app", result: WorkbenchPresentationAttachmentChunkSchema,
  }),
  // Browser identity lookup uses the workspace owner observation.
  "thread/identity/resolve": defineDaemonRequest<WorkbenchThreadIdentityResolveRequest, { data: WorkbenchThreadIdentityResolution | null }>()({
    route: "app", result: z.object({ data: WorkbenchThreadIdentityResolutionSchema.nullable() }).strict(),
  }),
  "questionnaire/respond": defineDaemonRequest<WorkbenchQuestionnaireRespondRequest, WorkbenchQuestionnaireRespondResult>()({
    route: "thread",
    result: z.object({ ok: z.literal(true), route: z.enum(["admitted", "live", "provider"]), warning: z.string().optional() }).strict(),
  }),
  // App-only: relayed calls and network grants are written by apps, never by browsers or other daemons.
  [RELAY_EXECUTE_METHOD]: defineDaemonRequest<RelayExecuteParams, RemoteCallOutcome>()({
    route: "app", result: RemoteCallOutcomeSchema,
  }),
  "network/grants/create": defineDaemonRequest<NetworkGrantCreate, { grant: NetworkGrant }>()({
    route: "app", result: z.object({ grant: NetworkGrantSchema }).strict(),
  }),
  "network/grants/list": defineDaemonRequest<Record<string, never>, { grants: NetworkGrant[] }>()({
    route: "app", result: z.object({ grants: z.array(NetworkGrantSchema) }).strict(),
  }),
  "network/grants/revoke": defineDaemonRequest<NetworkGrantRevoke, { revoked: number }>()({
    route: "app", result: z.object({ revoked: z.number().int().nonnegative() }).strict(),
  }),
  /** Marks a requesting thread's approved target revoked in its history. */
  "network/history/revoke": defineDaemonRequest<{ threadId: string; entryId: string }, { revoked: boolean }>()({
    route: "app", result: z.object({ revoked: z.boolean() }).strict(),
  }),
  "browse/sessions/read": defineDaemonRequest<WorkbenchBrowseSessionListRequest, WorkbenchBrowseSessionListResponse>()({
    route: "thread", result: z.object({ sessions: z.array(recordSchema) }).passthrough(),
  }),
  "browse/sessions/forget": defineDaemonRequest<BrowseSessionParams, WorkbenchBrowseSessionControlResponse>()({ route: "thread", result: recordSchema }),
  "browse/sessions/stop": defineDaemonRequest<BrowseSessionParams, WorkbenchBrowseSessionControlResponse>()({ route: "thread", result: recordSchema }),
};
