/*
 * Exports:
 * - threadDaemonRequests: daemon requests for draft launches, presentation export, thread identity lookup, questionnaire answers and Browse
 *   sessions.
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
  "browse/sessions/read": defineDaemonRequest<WorkbenchBrowseSessionListRequest, WorkbenchBrowseSessionListResponse>()({
    route: "thread", result: z.object({ sessions: z.array(recordSchema) }).passthrough(),
  }),
  "browse/sessions/forget": defineDaemonRequest<BrowseSessionParams, WorkbenchBrowseSessionControlResponse>()({ route: "thread", result: recordSchema }),
  "browse/sessions/stop": defineDaemonRequest<BrowseSessionParams, WorkbenchBrowseSessionControlResponse>()({ route: "thread", result: recordSchema }),
};
