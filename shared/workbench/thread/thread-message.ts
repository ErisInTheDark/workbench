/*
 * Exports:
 * - WorkbenchThreadMessageRequestSchema/WorkbenchThreadMessageRequest: validated global thread-message transport.
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
  workbenchOrigin: requiredText.optional(),
}).strict().superRefine(({ name, parent, threadId }, context) => {
  if ([Boolean(name), Boolean(parent), Boolean(threadId)].filter(Boolean).length !== 1) {
    context.addIssue({ code: "custom", message: "Exactly one of name, parent, or threadId is required." });
  }
});

export type WorkbenchThreadMessageRequest = z.infer<typeof WorkbenchThreadMessageRequestSchema>;
