/*
 * Exports:
 * - WorkbenchAppRpcRequestSchema/WorkbenchAppRpcRequest/WorkbenchAppRpcIntent: bounded browser-to-app JSON intents.
 * - WorkbenchAppRuntimeResponseSchema: validated app reload and frontend projection.
 * - WorkbenchPresentationIntent/WorkbenchPresentationIntentSchema: browser-owned draft edits only.
 */
import { z } from "zod";
import { WorkbenchNetworkActionSchema } from "./workbench-network";
import { WorkbenchClientStateMutationSchema } from "../state/workbench-client-state";
import { WORKBENCH_RELOAD_SCOPE_PATTERN } from "../reload/workbench-reload";
import { PresentationMutationSchema, type PresentationMutation } from "../state/workbench-presentation-state";
import { WorkbenchAppSettingsUpdateRequestSchema } from "./workbench-app-settings";
import { DaemonReloadRequestSchema } from "../workbench/daemon-reload";
import { DaemonIdSchema } from "../workbench/identity";
import { WorkspaceObserveSchema, WorkspaceReleaseSchema } from "../workbench/workspace/workspace-observation";
import { WorkspaceCommandSchema, WorkspaceTranscriptRequestSchema, WorkspaceThreadMutationSchema, WorkspaceDraftLaunchSchema, WorkspaceLayoutRequestSchema, WorkspaceThreadActionSchema } from "../workbench/workspace/workspace-commands";

export const WorkbenchAppRuntimeResponseSchema = z.object({
  frontendGeneration: z.object({
    javascript: z.string().min(1).max(200),
    stylesheet: z.string().min(1).max(200),
  }).strict().nullable().optional().default(null),
  reloadDirt: z.object({
    dirtyScopes: z.array(z.object({
      dependantScopes: z.array(z.string().regex(WORKBENCH_RELOAD_SCOPE_PATTERN)).default([]),
      description: z.string(),
      destructive: z.boolean(),
      scope: z.string().regex(WORKBENCH_RELOAD_SCOPE_PATTERN),
    }).strict()),
    error: z.string().max(500).nullable(),
    pendingScopes: z.array(z.string().regex(WORKBENCH_RELOAD_SCOPE_PATTERN)),
  }).strict(),
}).strict();

const browserStateId = z.uuid().nullable();
const id = z.number().int().positive();
export type WorkbenchPresentationIntent = Extract<PresentationMutation,
  { kind: "putDraft" | "deleteDraft" | "setDraftPriority" | "deleteAttachment" }>;
export const WorkbenchPresentationIntentSchema = PresentationMutationSchema.refine(
  value => ["putDraft", "deleteDraft", "setDraftPriority", "deleteAttachment"].includes(value.kind),
  "This presentation operation belongs to the app workspace.",
).transform(value => value as WorkbenchPresentationIntent);

export const WorkbenchAppRpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("workspace/thread/action"), params: WorkspaceThreadActionSchema }).strict(),
  z.object({ id, method: z.literal("workspace/daemon/reload"), params: z.object({
    daemonId: DaemonIdSchema.optional(), request: DaemonReloadRequestSchema,
  }).strict() }).strict(),
  z.object({ id, method: z.literal("workspace/command"), params: WorkspaceCommandSchema }).strict(),
  z.object({ id, method: z.literal("workspace/transcript"), params: WorkspaceTranscriptRequestSchema }).strict(),
  z.object({ id, method: z.literal("workspace/thread/mutate"), params: WorkspaceThreadMutationSchema }).strict(),
  z.object({ id, method: z.literal("workspace/layout"), params: WorkspaceLayoutRequestSchema }).strict(),
  z.object({ id, method: z.literal("workspace/observe"), params: WorkspaceObserveSchema }).strict(),
  z.object({ id, method: z.literal("workspace/release"), params: WorkspaceReleaseSchema }).strict(),
  z.object({ id, method: z.literal("workspace/draft/launch"), params: WorkspaceDraftLaunchSchema }).strict(),
  z.object({
    id, method: z.literal("app/network/action"),
    params: z.object({ action: WorkbenchNetworkActionSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/state/mutate"),
    params: z.object({ browserStateId, mutation: WorkbenchClientStateMutationSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/presentation/mutate"),
    params: z.object({ mutation: WorkbenchPresentationIntentSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/settings/read"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/settings/update"),
    params: WorkbenchAppSettingsUpdateRequestSchema,
  }).strict(),
  z.object({
    id, method: z.literal("app/port/read"),
    params: z.object({}).strict(),
  }).strict(),
]);
export type WorkbenchAppRpcRequest = z.infer<typeof WorkbenchAppRpcRequestSchema>;
export type WorkbenchAppRpcIntent = {
  [Method in WorkbenchAppRpcRequest["method"]]: Omit<
    Extract<WorkbenchAppRpcRequest, { method: Method }>, "id"
  >;
}[WorkbenchAppRpcRequest["method"]];
