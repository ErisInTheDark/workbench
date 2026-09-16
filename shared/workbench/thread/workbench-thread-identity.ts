/*
 * Exports:
 * - WorkbenchThreadIdentityResolveRequestSchema/WorkbenchThreadIdentityResolveRequest: scoped WB-first lookup input with optional provider admission.
 * - WorkbenchThreadIdentityResolutionSchema/WorkbenchThreadIdentityResolution: public identity without native bindings.
 * - WorkbenchThreadResponse: retain canonical identity on mapped provider responses.
 */
import { z } from "zod";
import { ProjectIdSchema, ThreadReferenceSchema, type ThreadReference, type WorkbenchThreadId } from "../identity.ts";

import { WorkbenchHarnessSchema } from "./thread-state.ts";

export const WorkbenchThreadIdentityResolveRequestSchema = z.object({
  allowProviderAdmission: z.boolean().default(true),
  threadId: ThreadReferenceSchema,
  projectId: ProjectIdSchema.optional(),
  harness: WorkbenchHarnessSchema.optional(),
});

export type WorkbenchThreadIdentityResolveRequest = Omit<z.input<typeof WorkbenchThreadIdentityResolveRequestSchema>, "threadId"> & {
  threadId: ThreadReference | WorkbenchThreadId;
};

export const WorkbenchThreadIdentityResolutionSchema = z.object({
  threadId: z.uuid().brand<"WorkbenchThreadId">(),
  projectId: ProjectIdSchema,
  harness: WorkbenchHarnessSchema,
});

export type WorkbenchThreadIdentityResolution = z.infer<typeof WorkbenchThreadIdentityResolutionSchema>;

export type WorkbenchThreadResponse<Response extends { thread: { id: string } }> =
  Omit<Response, "thread"> & { thread: Omit<Response["thread"], "id"> & { id: WorkbenchThreadId } };
