/*
 * Exports:
 * - DaemonHostMessageSchema/DaemonHostMessage: parent-owned demand and sleep commitment.
 * - DaemonSleepMessageSchema/DaemonSleepMessage: child-owned idle request and commitment result.
 */
import { z } from "zod";

export const DaemonHostMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workbench-daemon-demand"), required: z.boolean() }).strict(),
  z.object({ type: z.literal("workbench-daemon-sleep-commit"), id: z.uuid(), allowed: z.boolean() }).strict(),
]);
export type DaemonHostMessage = z.infer<typeof DaemonHostMessageSchema>;
export const DaemonSleepMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workbench-daemon-sleep-request"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("workbench-daemon-sleep-result"), id: z.uuid(), accepted: z.boolean() }).strict(),
]);
export type DaemonSleepMessage = z.infer<typeof DaemonSleepMessageSchema>;
