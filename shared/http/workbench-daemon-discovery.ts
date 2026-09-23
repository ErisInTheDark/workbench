/*
 * Exports:
 * - WorkbenchDaemonIdentitySchema/WorkbenchDaemonIdentity: non-waking durable daemon metadata.
 * - WorkbenchDaemonDiscoverySchema/WorkbenchDaemonDiscovery: bounded peer discovery observations.
 * - WorkbenchDaemonBrowserEndpointsSchema/WorkbenchDaemonDescriptorSchema: negotiated browser-safe daemon publication.
 */
import { z } from "zod";

const peer = {
  peerId: z.string().min(1).max(256),
  hostname: z.string().min(1).max(253),
};
export const WorkbenchDaemonIdentitySchema = z.object({
  protocol: z.literal(1),
  daemonId: z.uuid(),
  hostname: z.string().min(1).max(253),
  state: z.enum(["sleeping", "starting", "ready", "failed"]),
  wakeEnabled: z.boolean(),
}).strict();

const origin = z.url().max(2048).refine(value => {
  const parsed = new URL(value);
  return parsed.origin === value && !parsed.username && !parsed.password;
});
export const WorkbenchDaemonBrowserEndpointsSchema = z.object({
  httpOrigin: origin.refine(value => new URL(value).protocol === "http:"),
  secureOrigin: origin.refine(value => new URL(value).protocol === "https:").nullable(),
}).strict();
export const WorkbenchDaemonDescriptorSchema = z.object({
  identity: WorkbenchDaemonIdentitySchema,
  endpoints: WorkbenchDaemonBrowserEndpointsSchema.nullable(),
}).strict();

const observation = z.discriminatedUnion("phase", [
  z.object({ ...peer, phase: z.literal("pending") }).strict(),
  z.object({
    ...peer, phase: z.literal("verified"), identity: WorkbenchDaemonIdentitySchema,
    origin: z.url().max(2048),
    endpoints: WorkbenchDaemonBrowserEndpointsSchema.nullable().optional(),
  }).strict(),
  z.object({ ...peer, phase: z.literal("failed"), message: z.string().max(512) }).strict(),
]);
export const WorkbenchDaemonDiscoverySchema = z.object({
  error: z.string().max(512).nullable().optional(),
  refreshing: z.boolean(),
  peers: z.array(observation).max(4096),
}).strict();
export type WorkbenchDaemonIdentity = z.infer<typeof WorkbenchDaemonIdentitySchema>;
export type WorkbenchDaemonDiscovery = z.infer<typeof WorkbenchDaemonDiscoverySchema>;
export type WorkbenchDaemonBrowserEndpoints = z.infer<typeof WorkbenchDaemonBrowserEndpointsSchema>;
