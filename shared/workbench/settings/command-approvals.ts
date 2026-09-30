/*
 * Exports:
 * - CommandApprovalRuleSchema/CommandApprovalRule: saved exact-directory token prefix.
 * - CommandApprovalReadSchema/CommandApprovalRemoveSchema/CommandApprovalPatchSchema: project-scoped settings requests.
 * - CommandApprovalRead/CommandApprovalRemove/CommandApprovalPatch: settings request inputs.
 * - CommandApprovalSnapshotSchema/CommandApprovalSnapshot: authoritative saved-rule list.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity.ts";

export const CommandApprovalRuleSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  workdir: z.string().min(1),
  prefix: z.array(z.string().min(1)).min(1),
}).strict();
export type CommandApprovalRule = z.infer<typeof CommandApprovalRuleSchema>;
export const CommandApprovalReadSchema = z.object({ projectId: ProjectIdSchema }).strict();
export const CommandApprovalRemoveSchema = CommandApprovalReadSchema.extend({ id: z.string().uuid() });
export const CommandApprovalPatchSchema = CommandApprovalReadSchema.extend({
  workdir: z.string().min(1).max(4096),
  add: z.array(z.string().min(1).max(1024)).max(100),
  removeIds: z.array(z.string().uuid()).max(100),
}).strict();
export type CommandApprovalRead = z.input<typeof CommandApprovalReadSchema>;
export type CommandApprovalRemove = z.input<typeof CommandApprovalRemoveSchema>;
export type CommandApprovalPatch = z.input<typeof CommandApprovalPatchSchema>;
export const CommandApprovalSnapshotSchema = z.object({ rules: z.array(CommandApprovalRuleSchema) }).strict();
export type CommandApprovalSnapshot = z.infer<typeof CommandApprovalSnapshotSchema>;
