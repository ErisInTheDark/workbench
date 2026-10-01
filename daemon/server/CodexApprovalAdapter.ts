/*
 * Exports:
 * - CodexApprovalPort: native-id approval view consumed by the Codex bridge.
 * - default CodexApprovalAdapter: translate Codex thread, turn, and item references around the shared approval owner.
 */
import { getCodexItemIdentityKind } from "workbench-shared/codex/thread-item-source";
import {
  ItemReferenceSchema, NativeTurnIdSchema,
  type NativeThreadId, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import type WorkbenchApprovalController from "./WorkbenchApprovalController";
import type { WorkbenchApprovalOpenResult } from "./WorkbenchApprovalController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";

export interface CodexApprovalPort {
  open(input: {
    threadId: NativeThreadId;
    turnId: string | null;
    itemId: string | null;
    requestKey: string;
    subject: WorkbenchApprovalSubject;
  }): Promise<WorkbenchApprovalOpenResult>;
  close(requestKey: string): void;
}

export default class CodexApprovalAdapter implements CodexApprovalPort {
  constructor(
    private readonly approvals: () => Pick<WorkbenchApprovalController, "open" | "close">,
    private readonly threads: Pick<WorkbenchThreadIdentityController, "knownNativeBinding" | "workbenchIdForNative" | "workbenchTurnIdForNative">,
    private readonly items: Pick<WorkbenchTranscriptIdentityController, "admit" | "findItemIdForSource" | "findItemIdForReference">,
  ) {}

  async open(input: Parameters<CodexApprovalPort["open"]>[0]) {
    const binding = this.threads.knownNativeBinding("codex", input.threadId);
    const threadId = this.threads.workbenchIdForNative(binding);
    const turnId = input.turnId === null
      ? null
      : this.threads.workbenchTurnIdForNative({ ...binding, nativeTurnId: NativeTurnIdSchema.parse(input.turnId) });
    const itemId = turnId && input.itemId ? await this.itemId(threadId, turnId, input.itemId) : null;
    return await this.approvals().open({
      harness: "codex", threadId, turnId, itemId, requestKey: input.requestKey, subject: input.subject, allowSession: true,
    });
  }

  close(requestKey: string) {
    this.approvals().close("codex", requestKey);
  }

  /** Approvals arrive for items Codex may not have announced yet; admit the same source its notifications use. */
  private async itemId(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, reference: string) {
    const source = {
      turnId, kind: getCodexItemIdentityKind({ id: reference }), reference, component: { kind: "item" as const, index: 0 },
    };
    const known = this.items.findItemIdForSource(threadId, source)
      ?? this.items.findItemIdForReference(threadId, turnId, ItemReferenceSchema.parse(reference));
    if (known) return known;
    const [admitted] = await this.items.admit([{ threadId, sources: [source] }]);
    return admitted?.itemId ?? null;
  }
}
