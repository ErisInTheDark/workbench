/*
 * Exports:
 * - WorkbenchThreadMessageRequestSchema/WorkbenchThreadMessageRequest: validated global thread-message transport.
 * - WorkbenchMessageWaitTargetsSchema/WorkbenchMessageWaitRequestSchema/WorkbenchMessageWaitRequest: validated sender selection and message-wait transport.
 */
import { z } from "zod";

import { ThreadReferenceSchema } from "../identity";

const requiredText = z.string().trim().min(1);

export const WorkbenchThreadMessageRequestSchema = z.object({
  action: z.literal("message").optional(),
  callerThreadId: ThreadReferenceSchema,
  cwd: requiredText,
  message: requiredText,
  name: requiredText.optional(),
  parent: z.literal(true).optional(),
  threadId: ThreadReferenceSchema.optional(),
  userVisibleSimpleVersion: requiredText,
  workbenchOrigin: requiredText.optional(),
}).strict().superRefine(({ name, parent, threadId }, context) => {
  if ([Boolean(name), Boolean(parent), Boolean(threadId)].filter(Boolean).length !== 1) {
    context.addIssue({ code: "custom", message: "Exactly one of name, parent, or threadId is required." });
  }
});

export type WorkbenchThreadMessageRequest = z.infer<typeof WorkbenchThreadMessageRequestSchema>;

export const WorkbenchMessageWaitTargetsSchema = z.object({
  names: z.array(requiredText).optional(),
  threadIds: z.array(ThreadReferenceSchema).optional(),
}).strict().refine(({ names = [], threadIds = [] }) => names.length + threadIds.length > 0, {
  message: "At least one sender name or thread ID is required.",
});

export const WorkbenchMessageWaitRequestSchema = WorkbenchMessageWaitTargetsSchema.safeExtend({
  callerThreadId: ThreadReferenceSchema,
  cwd: requiredText,
  waitId: requiredText,
});

export type WorkbenchMessageWaitRequest = z.infer<typeof WorkbenchMessageWaitRequestSchema>;
