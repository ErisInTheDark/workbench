/*
 * Exports:
 * - DaemonHostMessageSchema/DaemonHostMessage: parent-owned demand and sleep commitment.
 * - DaemonOwnedMessageSchema: parent confirmation that the daemon's process container holds it.
 * - DaemonSleepMessageSchema/DaemonSleepMessage: child-owned idle request and commitment result.
 * - DaemonStartupDiagnosticSchema: typed startup work observable by process supervisors.
 * - DaemonDiagnosticMessageSchema/DaemonDiagnosticMessage: bounded child diagnostic relayed by an observing host.
 */
import { z } from "zod";
import { WorkbenchDatabaseDiagnosticEventSchema } from "../database/workbench-database-diagnostic.ts";

export const DaemonOwnedMessageSchema = z.object({ type: z.literal("workbench-daemon-owned") }).strict();
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
export const DaemonStartupDiagnosticSchema = z.object({
  source: z.literal("startup"),
  operation: z.literal("reloadSourceBaseline"),
  phase: z.enum(["pending", "completed"]),
  elapsedMs: z.number().nonnegative().nullable(),
}).strict();
export const DaemonDiagnosticMessageSchema = z.object({
  type: z.literal("workbench-daemon-diagnostic"),
  diagnostic: z.discriminatedUnion("source", [
    WorkbenchDatabaseDiagnosticEventSchema,
    DaemonStartupDiagnosticSchema,
  ]),
}).strict();
export type DaemonDiagnosticMessage = z.infer<typeof DaemonDiagnosticMessageSchema>;
