/*
 * Exports:
 * - WorkbenchThreadLaunchRequestSchema/WorkbenchThreadLaunchRequest: immutable first-turn intent for one concrete daemon project.
 * - WorkbenchThreadLaunchLocationSchema/WorkbenchThreadLaunchLocation: daemon-captured ordered execution roots.
 * - WorkbenchThreadLaunchReadSchema: durable launch lookup.
 * - WorkbenchThreadLaunchStateSchema/WorkbenchThreadLaunchState: recorded progress without unsafe retry promises.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity.ts";
import { WorkbenchMessageContextSchema, WorkbenchUserInputSchema } from "../provider/provider-input.ts";
import { WorkbenchComposerProfileSelectionSchema } from "./thread-state.ts";

export const WorkbenchThreadLaunchRequestSchema = z.object({
  launchId: z.uuid(),
  projectId: ProjectIdSchema,
  profile: WorkbenchComposerProfileSelectionSchema,
  firstInput: z.array(WorkbenchUserInputSchema).min(1),
  clientMessageId: z.string().min(1),
  creationContext: WorkbenchMessageContextSchema.optional(),
  messageContext: WorkbenchMessageContextSchema.optional(),
  additionalWritableRoots: z.array(z.string().min(1)).optional(),
}).strict();
export type WorkbenchThreadLaunchRequest = z.infer<typeof WorkbenchThreadLaunchRequestSchema>;
export const WorkbenchThreadLaunchLocationSchema = z.object({
  rootPath: z.string().min(1),
  roots: z.array(z.string().min(1)).min(1),
}).strict();
export type WorkbenchThreadLaunchLocation = z.infer<typeof WorkbenchThreadLaunchLocationSchema>;

export const WorkbenchThreadLaunchReadSchema = z.object({ launchId: z.uuid() }).strict();
export const WorkbenchThreadLaunchStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("prepared"), launchId: z.uuid() }).strict(),
  z.object({ phase: z.literal("creating"), launchId: z.uuid() }).strict(),
  z.object({ phase: z.literal("created"), launchId: z.uuid(), threadId: z.string().min(1) }).strict(),
  z.object({ phase: z.literal("sending"), launchId: z.uuid(), threadId: z.string().min(1) }).strict(),
  z.object({ phase: z.literal("accepted"), launchId: z.uuid(), threadId: z.string().min(1), turnId: z.string().min(1) }).strict(),
  z.object({ phase: z.literal("failed"), launchId: z.uuid(), reason: z.string().max(512) }).strict(),
  z.object({ phase: z.literal("unknown"), launchId: z.uuid(), threadId: z.string().min(1).nullable(), reason: z.string().max(512) }).strict(),
]);
export type WorkbenchThreadLaunchState = z.infer<typeof WorkbenchThreadLaunchStateSchema>;
