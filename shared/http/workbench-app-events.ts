/*
 * Exports:
 * - WORKBENCH_APP_NETWORK_SOCKET_PATH: the app workspace upgrade route.
 * - WorkbenchAppNetworkEventSchema/WorkbenchAppNetworkEvent: validated workspace notifications.
 * - conformWorkbenchAppNetworkEvent: repair envelopes and return repaired transcript/delta payloads.
 */
import { z } from "zod";
import { conformToZodSchema, type ZodSchemaRepair } from "../workbench/zod-schema-conformer";
import { conformWorkspaceObservationDelta } from "../workbench/workspace/workspace-observation-conformance";
import { WorkspaceObservationDeltaSchema, WorkspaceTranscriptStateSchema } from "../workbench/workspace/workspace-observation";
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
  z.object({ kind: z.literal("workspaceDelta"), delta: WorkspaceObservationDeltaSchema }).strict(),
  z.object({ kind: z.literal("presentation-import"), status: WorkbenchPresentationImportStatusSchema }).strict(),
  /** An MCP server OAuth callback reached the app and its daemon answered. */
  z.object({ kind: z.literal("mcp-sign-in"), daemonId: DaemonIdSchema, outcome: z.enum(["signedIn", "failed"]) }).strict(),
]);
export type WorkbenchAppNetworkEvent = z.infer<typeof WorkbenchAppNetworkEventSchema>;

export function conformWorkbenchAppNetworkEvent(value: unknown): ZodSchemaRepair<WorkbenchAppNetworkEvent> {
  const envelope = conformToZodSchema(z.looseObject({ kind: z.string() }), value);
  if (envelope.success === false) return {
    success: false, repairedPaths: envelope.repairedPaths, discardedPaths: envelope.discardedPaths,
  };
  const event = envelope.data;
  if (event.kind === "workspaceDelta") {
    const delta = conformWorkspaceObservationDelta(event.delta);
    const repairedPaths = delta.repairedPaths.map(path => ["delta", ...path]);
    const discardedPaths = delta.discardedPaths.map(path => ["delta", ...path]);
    if (!delta.success) return { success: false, repairedPaths, discardedPaths };
    const result = conformToZodSchema(WorkbenchAppNetworkEventSchema, { ...event, delta: delta.data });
    return { ...result, repairedPaths: [...repairedPaths, ...result.repairedPaths], discardedPaths };
  }
  if (event.kind === "transcriptSnapshot" || event.kind === "transcriptStream") {
    const transcript = event.kind === "transcriptSnapshot"
      ? conformWorkbenchTranscriptUpdated(event.data) : conformWorkbenchTranscriptStreamed(event.data);
    const repairedPaths = transcript.repairedPaths.map(path => ["data", ...path]);
    if (!("data" in transcript)) return { success: false, repairedPaths, discardedPaths: transcript.issues.map(issue => ["data", ...issue.path]) };
    const result = conformToZodSchema(WorkbenchAppNetworkEventSchema, { ...event, data: transcript.data });
    return { ...result, repairedPaths: [...repairedPaths, ...result.repairedPaths] };
  }
  return conformToZodSchema(WorkbenchAppNetworkEventSchema, value);
}
