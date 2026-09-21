/*
 * Exports:
 * - WorkbenchAppProcessInfoSchema/WorkbenchAppProcessInfo: private app identity and log location.
 */
import { z } from "zod";

export const WorkbenchAppProcessInfoSchema = z.object({
  instanceId: z.uuid(),
  logDirectory: z.string().min(1),
  logPrefix: z.literal("workbench-app"),
}).strict();
export type WorkbenchAppProcessInfo = z.infer<typeof WorkbenchAppProcessInfoSchema>;
