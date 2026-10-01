/*
 * Exports:
 * - default WorkbenchLocalApprovalTransport: in-process approval transport for tools Workbench hosts itself; waits for the owner's decision.
 */
import { randomUUID } from "node:crypto";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchApprovalDecision, WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import type WorkbenchApprovalController from "./WorkbenchApprovalController";

export default class WorkbenchLocalApprovalTransport {
  private readonly waiters = new Map<string, { threadId: string; resolve: (decision: WorkbenchApprovalDecision) => void }>();

  constructor(
    private readonly harness: WorkbenchHarness,
    private readonly approvals: () => Pick<WorkbenchApprovalController, "open" | "close">,
  ) {}

  async request(input: {
    threadId: WorkbenchThreadId;
    turnId: WorkbenchTurnId | null;
    itemId: string | null;
    subject: WorkbenchApprovalSubject;
  }, signal: AbortSignal): Promise<WorkbenchApprovalDecision> {
    signal.throwIfAborted();
    const requestKey = randomUUID();
    const approvals = this.approvals();
    let stopAbort = () => {};
    const decided = new Promise<WorkbenchApprovalDecision>((resolve, reject) => {
      this.waiters.set(requestKey, { threadId: input.threadId, resolve });
      const onAbort = () => reject(signal.reason ?? new Error("The approval request was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      stopAbort = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      const opened = await approvals.open({ ...input, harness: this.harness, requestKey, allowSession: false });
      if (opened.kind === "decided") return opened.decision;
      if (opened.kind === "closed") {
        signal.throwIfAborted();
        throw new Error("The approval request ended before a decision.");
      }
      return await decided;
    } finally {
      stopAbort();
      this.waiters.delete(requestKey);
      approvals.close(this.harness, requestKey);
      decided.catch(() => undefined);
    }
  }

  deliver(input: { threadId: string; requestKey: string; decision: WorkbenchApprovalDecision }) {
    const waiter = this.waiters.get(input.requestKey);
    if (!waiter || waiter.threadId !== input.threadId) return false;
    this.waiters.delete(input.requestKey);
    waiter.resolve(input.decision);
    return true;
  }
}
