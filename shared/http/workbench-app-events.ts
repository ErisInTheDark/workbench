/*
 * Exports:
 * - WORKBENCH_APP_NETWORK_SOCKET_PATH: the app workspace upgrade route.
 * - WorkbenchAppNetworkEventSchema/WorkbenchAppNetworkEvent: validated workspace notifications.
 */
import { z } from "zod";
import { WorkspaceObservationSchema, WorkspaceTranscriptStateSchema } from "../workbench/workspace/workspace-observation";
import { VoiceSessionEventSchema } from "../workbench/voice/voice-session-contract";
import { isWorkbenchPublicNotification, type WorkbenchTranscriptNotification } from "../workbench/provider/provider-observation";
import { ProviderKeySchema } from "../workbench/provider/provider-key";
import { DaemonIdSchema } from "../workbench/identity";
import {
  conformWorkbenchTranscriptUpdated, conformWorkbenchTranscriptStreamed,
  type WorkbenchTranscriptUpdatedParams, type WorkbenchTranscriptStreamedParams,
} from "../workbench/database/transcript/workbench-transcript-contract";
import {
  WorkbenchPresentationImportStatusSchema,
} from "../state/workbench-presentation-state.ts";

export const WORKBENCH_APP_NETWORK_SOCKET_PATH = "/api/workbench-network/socket";

export const WorkbenchAppNetworkEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("threadEvent"), harness: ProviderKeySchema, daemonId: DaemonIdSchema,
    notification: z.custom<WorkbenchTranscriptNotification>(isWorkbenchPublicNotification),
  }).strict(),
  z.object({ kind: z.literal("transcriptSnapshot"),
    data: z.custom<WorkbenchTranscriptUpdatedParams>(value => conformWorkbenchTranscriptUpdated(value).success),
  }).strict(),
  z.object({ kind: z.literal("transcriptStream"),
    data: z.custom<WorkbenchTranscriptStreamedParams>(value => conformWorkbenchTranscriptStreamed(value).success),
  }).strict(),
  z.object({ kind: z.literal("transcriptState"), data: WorkspaceTranscriptStateSchema }).strict(),
  z.object({ kind: z.literal("voice"), event: VoiceSessionEventSchema }).strict(),
  z.object({ kind: z.literal("workspace"), observation: WorkspaceObservationSchema }).strict(),
  z.object({ kind: z.literal("presentation-import"), status: WorkbenchPresentationImportStatusSchema }).strict(),
]);
export type WorkbenchAppNetworkEvent = z.infer<typeof WorkbenchAppNetworkEventSchema>;
