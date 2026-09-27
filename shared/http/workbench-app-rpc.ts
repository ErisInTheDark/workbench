/*
 * Exports:
 * - WorkbenchAppRpcRequestSchema/WorkbenchAppRpcRequest/WorkbenchAppRpcIntent: bounded browser-to-app JSON intents.
 * - WorkbenchAppRuntimeResponseSchema: validated app reload and frontend projection.
 */
import { z } from "zod";
import { WorkbenchNetworkActionSchema } from "./workbench-network";
import {
  WorkbenchClientStateMutationSchema, WorkbenchDaemonRegistrationRequestSchema,
  WorkbenchProjectRemapSchema,
} from "../state/workbench-client-state";
import { WORKBENCH_RELOAD_SCOPE_PATTERN } from "../reload/workbench-reload";
import { PresentationMutationSchema } from "../state/workbench-presentation-state";
import { WorkbenchAppSettingsUpdateRequestSchema } from "./workbench-app-settings";

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

export const WorkbenchAppRpcRequestSchema = z.discriminatedUnion("method", [
  z.object({
    id,
    method: z.literal("app/network/read"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/network/action"),
    params: z.object({ action: WorkbenchNetworkActionSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/state/read"),
    params: z.object({ browserStateId, sinceRevision: z.number().int().nonnegative().nullable() }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/state/mutate"),
    params: z.object({ browserStateId, mutation: WorkbenchClientStateMutationSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/state/register"),
    params: z.object({ browserStateId, request: WorkbenchDaemonRegistrationRequestSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/state/remap"),
    params: z.object({ browserStateId, request: WorkbenchProjectRemapSchema }).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/runtime/read"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/presentation/read"),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    id, method: z.literal("app/presentation/mutate"),
    params: z.object({ mutation: PresentationMutationSchema }).strict(),
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
