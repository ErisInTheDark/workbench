/*
 * Exports:
 * - WorkbenchDaemonIdentitySchema/WorkbenchDaemonIdentity: non-waking durable daemon metadata.
 * - WorkbenchDaemonDiscoverySchema/WorkbenchDaemonDiscovery: bounded peer discovery observations.
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

const observation = z.discriminatedUnion("phase", [
  z.object({ ...peer, phase: z.literal("pending") }).strict(),
  z.object({
    ...peer, phase: z.literal("verified"), identity: WorkbenchDaemonIdentitySchema,
    origin: z.url().max(2048),
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
