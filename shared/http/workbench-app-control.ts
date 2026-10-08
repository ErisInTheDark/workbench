/*
 * Exports:
 * - WorkbenchAppProcessInfoSchema/WorkbenchAppProcessInfo: private app identity and log location.
 * - WorkbenchAppControlRuntimeSchema/WorkbenchAppControlRuntime: local viewer summary of reload dirt, update and the in-flight operation.
 * - WorkbenchAppControlPullRequestSchema: local viewer pull intent.
 * - WorkbenchAppControlLaunchUrlSchema/WorkbenchAppControlLaunchUrl: the browser address local viewers open.
 */
import { z } from "zod";
import { InstallationUpdateSchema } from "../workbench/installation-update";
import { WorkbenchReloadOperationSchema } from "../reload/workbench-reload";

export const WorkbenchAppProcessInfoSchema = z.object({
  instanceId: z.uuid(),
  logDirectory: z.string().min(1),
  logPrefix: z.literal("workbench-app"),
}).strict();
export type WorkbenchAppProcessInfo = z.infer<typeof WorkbenchAppProcessInfoSchema>;

/** `dirty`: any app, host or attached-daemon scope needs reloading; `destructive`: reload all includes a destructive one. */
export const WorkbenchAppControlRuntimeSchema = z.object({
  dirty: z.boolean(),
  destructive: z.boolean(),
  update: InstallationUpdateSchema.nullable(),
  operation: WorkbenchReloadOperationSchema,
}).strict();
export type WorkbenchAppControlRuntime = z.infer<typeof WorkbenchAppControlRuntimeSchema>;

export const WorkbenchAppControlPullRequestSchema = z.object({ reload: z.boolean() }).strict();

/** `url`: the browser address for the chosen connection mode; null while networking is still resolving it. */
export const WorkbenchAppControlLaunchUrlSchema = z.object({ url: z.url().nullable() }).strict();
export type WorkbenchAppControlLaunchUrl = z.infer<typeof WorkbenchAppControlLaunchUrlSchema>;
