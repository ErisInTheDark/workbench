/*
 * Exports:
 * - WorkbenchServiceEndpointSchema/WorkbenchServiceEndpoint: private process-bound control publication.
 * - WorkbenchServiceRegistrationSchema/WorkbenchServiceRegistration: session-owned app targets.
 * - WorkbenchServiceSnapshotSchema/WorkbenchServiceSnapshot: service lifecycle and network projection.
 * - WorkbenchServiceRequestSchema/WorkbenchServiceRequest: named control intents.
 * - WorkbenchServiceResponseSchema/WorkbenchServiceResponse: typed replies and snapshot events.
 */
import { z } from "zod";
import {
  WorkbenchNetworkActionSchema, WorkbenchNetworkResultSchema, WorkbenchNetworkSnapshotSchema,
} from "./workbench-network.ts";
import { WorkbenchDaemonDiscoverySchema, WorkbenchDaemonIdentitySchema } from "./workbench-daemon-discovery.ts";
import { WorkbenchDaemonEndpointSchema } from "./workbench-daemon-endpoint.ts";
import { WorkbenchReloadDirtSnapshotSchema } from "../reload/workbench-reload.ts";

const localOrigin = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && url.origin === value && Boolean(url.port) && !url.username && !url.password;
}, "Expected an explicit loopback HTTP origin.");
export const WorkbenchServiceEndpointSchema = WorkbenchDaemonEndpointSchema.extend({
  token: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const WorkbenchServiceRegistrationSchema = z.object({
  appOrigin: localOrigin,
  previewOrigin: localOrigin.nullable().default(null),
  previewHostPort: z.number().int().min(1).max(65535).nullable().default(null),
  retainedHostPort: z.number().int().min(1).max(65535).nullable().default(null),
  privateAppAllowed: z.boolean().default(true),
  ingressToken: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const WorkbenchServiceSnapshotSchema = z.object({
  identity: WorkbenchDaemonIdentitySchema,
  failure: z.string().max(512).nullable(),
  daemonOrigin: localOrigin.nullable(),
  network: WorkbenchNetworkSnapshotSchema.nullable(),
  discovery: WorkbenchDaemonDiscoverySchema.default({ refreshing: false, peers: [] }),
  reloadDirt: WorkbenchReloadDirtSnapshotSchema.optional(),
}).strict();
const id = z.uuid();
const caller = z.object({
  deviceNodeId: z.string().min(1).max(256).nullable(),
  origin: z.url().max(2048),
}).strict();
export const WorkbenchServiceRequestSchema = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("service/status/read") }).strict(),
  z.object({ id, method: z.literal("service/process/read") }).strict(),
  z.object({ id, method: z.literal("service/daemon/stop"), instanceId: z.uuid() }).strict(),
  z.object({ id, method: z.literal("service/stop"), instanceId: z.uuid() }).strict(),
  z.object({ id, method: z.literal("service/emergency/stop"), instanceId: z.uuid() }).strict(),
  z.object({ id, method: z.literal("service/app/register"), registration: WorkbenchServiceRegistrationSchema }).strict(),
  z.object({ id, method: z.literal("service/daemon/wake"), retry: z.boolean().default(false) }).strict(),
  z.object({ id, method: z.literal("service/wake/enable"), enabled: z.boolean() }).strict(),
  z.object({ id, method: z.literal("service/network/action"), action: WorkbenchNetworkActionSchema, caller: caller.optional() }).strict(),
  z.object({
    id, method: z.literal("service/network/settings"),
    mode: z.enum(["localhost", "tailnet-ip", "tailnet-service"]),
    port: z.number().int().min(1).max(65535),
  }).strict(),
  z.object({ id, method: z.literal("service/discovery/refresh") }).strict(),
  z.object({ id, method: z.literal("service/reload"), scopes: z.array(z.enum(["host:database", "host:network", "host:http", "host:process"])).min(1).max(4) }).strict(),
  z.object({ id, method: z.literal("service/request/cancel"), requestId: id }).strict(),
]);
export const WorkbenchServiceResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshot: WorkbenchServiceSnapshotSchema }).strict(),
  z.object({ kind: z.literal("ok"), id }).strict(),
  z.object({
    kind: z.literal("process"), id, instanceId: z.uuid(),
    logDirectory: z.string().min(1), logPrefix: z.literal("workbench-host"),
  }).strict(),
  z.object({ kind: z.literal("network-result"), id, result: WorkbenchNetworkResultSchema }).strict(),
  z.object({ kind: z.literal("error"), id, message: z.string().max(512) }).strict(),
]);
export type WorkbenchServiceEndpoint = z.infer<typeof WorkbenchServiceEndpointSchema>;
export type WorkbenchServiceRegistration = z.infer<typeof WorkbenchServiceRegistrationSchema>;
export type WorkbenchServiceSnapshot = z.infer<typeof WorkbenchServiceSnapshotSchema>;
export type WorkbenchServiceRequest = z.infer<typeof WorkbenchServiceRequestSchema>;
export type WorkbenchServiceResponse = z.infer<typeof WorkbenchServiceResponseSchema>;
