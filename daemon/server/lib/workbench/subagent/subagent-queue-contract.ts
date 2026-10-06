/*
 * Exports:
 * - WorkbenchSubagentQueueInputSchema: agent input for subagent_queue (join, info, move, or yield).
 * - WorkbenchSubagentDequeueInputSchema: agent input for subagent_dequeue (leave, or parent kick by name).
 * - WorkbenchSubagentQueueRequestSchema: daemon request body for both queue commands, with caller identity.
 * - WorkbenchSubagentQueueRequest: parsed daemon request body.
 * - SUBAGENT_QUEUE_PARENT_NAME: member reference naming the queue owner.
 */
import { z } from "zod";

export const SUBAGENT_QUEUE_PARENT_NAME = "parent";

const requiredText = z.string().trim().min(1);
const queueName = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u,
  "Queue names use 1-64 letters, digits, '_', '.' or '-', starting with a letter or digit.",
);

const queueFields = {
  after: requiredText.optional(),
  before: requiredText.optional(),
  description: requiredText.max(500).optional(),
  name: requiredText.optional(),
  queue: queueName,
};
const dequeueFields = { name: requiredText.optional(), queue: queueName };

type QueueFields = { after?: string; before?: string; description?: string; name?: string };

function checkQueueFields({ after, before, description, name }: QueueFields, context: z.RefinementCtx) {
  if (after && before) context.addIssue({ code: "custom", message: "Use after or before, not both." });
  if (name && !after && !before) context.addIssue({ code: "custom", message: "name moves another member and needs after or before." });
  if (name && description) context.addIssue({ code: "custom", message: "description applies to your own membership, not to a moved member." });
}

export const WorkbenchSubagentQueueInputSchema = z.object(queueFields).strict().superRefine(checkQueueFields);
export const WorkbenchSubagentDequeueInputSchema = z.object(dequeueFields).strict();

const caller = { callerThreadId: requiredText, cwd: requiredText };

export const WorkbenchSubagentQueueRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...queueFields, ...caller, action: z.literal("queue") }).strict(),
  z.object({ ...dequeueFields, ...caller, action: z.literal("dequeue") }).strict(),
]).superRefine((request, context) => {
  if (request.action === "queue") checkQueueFields(request, context);
});

export type WorkbenchSubagentQueueRequest = z.output<typeof WorkbenchSubagentQueueRequestSchema>;
