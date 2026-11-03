/*
 * Exports:
 * - SubagentApprovalChoice: a parent's answer to its child's outside-sandbox request: forward it to the user, or deny it.
 * - resolveSubagentApproval: decide a child's one shown request by that choice and report the outcome to the parent.
 */
import type { WorkbenchApprovalDecision, WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";

export type SubagentApprovalChoice =
  | { kind: "forward"; justification: string | null }
  | { kind: "deny"; feedback: string | null };

/**
 * The user sees the child's request on the parent's thread, attributed to the child unless the parent words it itself. Saved
 * command rules would bind the parent's project, never the child's, so a forwarded request cannot be remembered.
 */
function forwardedSubject(subject: WorkbenchApprovalSubject, name: string, justification: string | null): WorkbenchApprovalSubject {
  const reason = (original: string | null) => justification ?? `${name}: ${original ?? "(no justification given)"}`;
  return subject.kind === "command"
    ? { ...subject, justification: reason(subject.justification), rememberable: false }
    : { ...subject, reason: reason(subject.reason) };
}

export async function resolveSubagentApproval(child: {
  name: string;
  read(): Promise<ReadonlyArray<{ requestKey: string; subject: WorkbenchApprovalSubject }>>;
  decide(requestKey: string, decision: WorkbenchApprovalDecision): Promise<unknown>;
  /** Ask the user on the parent's thread. */
  ask(subject: WorkbenchApprovalSubject, signal: AbortSignal): Promise<WorkbenchApprovalDecision>;
}, choice: SubagentApprovalChoice, signal: AbortSignal) {
  const pending = await child.read();
  if (pending.length !== 1) {
    throw new Error(pending.length
      ? `${child.name} has ${pending.length} pending approvals; wait until only one remains.`
      : `${child.name} has no pending approval.`);
  }
  const [request] = pending as [typeof pending[number]];
  const decision: WorkbenchApprovalDecision = choice.kind === "deny"
    ? { kind: "decline", ...(choice.feedback ? { feedback: choice.feedback } : {}) }
    : await child.ask(forwardedSubject(request.subject, child.name, choice.justification), signal);
  await child.decide(request.requestKey, decision);
  if (choice.kind === "deny") return `Denied ${child.name}'s request.`;
  return decision.kind === "decline" ? `The user denied ${child.name}'s request.` : `The user approved ${child.name}'s request.`;
}
