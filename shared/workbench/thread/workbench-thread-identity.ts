/*
 * Keywords: Workbench identity, public thread resolution.
 * Exports:
 * - WorkbenchThreadIdentityResolveRequestSchema/WorkbenchThreadIdentityResolveRequest: scoped WB-first lookup input.
 * - WorkbenchThreadIdentityResolutionSchema/WorkbenchThreadIdentityResolution: public identity without native bindings.
 */
import { z } from "zod";

import { WorkbenchHarnessSchema } from "./thread-state.ts";

export const WorkbenchThreadIdentityResolveRequestSchema = z.object({
  threadId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
  harness: WorkbenchHarnessSchema.optional(),
});

export type WorkbenchThreadIdentityResolveRequest = z.infer<typeof WorkbenchThreadIdentityResolveRequestSchema>;

export const WorkbenchThreadIdentityResolutionSchema = z.object({
  threadId: z.uuid(),
  projectId: z.string().min(1),
  harness: WorkbenchHarnessSchema,
});

export type WorkbenchThreadIdentityResolution = z.infer<typeof WorkbenchThreadIdentityResolutionSchema>;
