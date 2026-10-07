/*
 * Exports:
 * - WorkbenchApprovalModeSchema: daemon-project outside-sandbox policy (approvals on, skip, auto-approve).
 * - DEFAULT_APPROVAL_MODE: mode used when a selection carries none.
 * - resolveApprovalMode: read a selection's effective mode.
 */
import { z } from "zod";
import type { WorkbenchApprovalMode, WorkbenchComposerProfileTargetSelection } from "../../types.ts";

export const WorkbenchApprovalModeSchema = z.enum(["approvals", "skip", "auto"]) satisfies z.ZodType<WorkbenchApprovalMode>;

export const DEFAULT_APPROVAL_MODE: WorkbenchApprovalMode = "approvals";

export function resolveApprovalMode(selection: Pick<WorkbenchComposerProfileTargetSelection, "approvalMode"> | null | undefined) {
  return selection?.approvalMode ?? DEFAULT_APPROVAL_MODE;
}
