/*
 * Exports:
 * - WorkbenchApprovalSubject: provider-neutral description of one action awaiting approval.
 * - WorkbenchApprovalDecision: Workbench decision a transport carries back to its native request.
 * - WorkbenchApprovalOutcome/WORKBENCH_APPROVAL_OUTCOMES: recorded per-tool-item approval result.
 * - WorkbenchApprovalOutcomeEntry: one recorded outcome bound to a stable transcript item identity.
 */
import type { CommandAction } from "../thread/workbench-thread-items.ts";

export type WorkbenchApprovalSubject =
  | {
    kind: "command";
    command: string;
    cwd: string;
    commandActions: CommandAction[];
    justification: string | null;
    networkTarget: string | null;
    /** Whether saved command rules may decide or be offered for this request. */
    rememberable: boolean;
    suggestedPrefixes: string[][];
  }
  | { kind: "fileChange"; reason: string | null; grantRoot: string | null }
  | { kind: "permissions"; cwd: string; reason: string | null; permissions: string | null }
  | { kind: "patch"; reason: string | null; grantRoot: string | null; paths: string[] };

export type WorkbenchApprovalDecision =
  | { kind: "allowOnce" | "allowSession" }
  | { kind: "decline"; feedback?: string };

export const WORKBENCH_APPROVAL_OUTCOMES = ["approved", "autoApproved", "denied"] as const;
export type WorkbenchApprovalOutcome = typeof WORKBENCH_APPROVAL_OUTCOMES[number];

export interface WorkbenchApprovalOutcomeEntry {
  threadId: string;
  turnId: string;
  itemId: string;
  outcome: WorkbenchApprovalOutcome;
  resolvedAt: number;
}
