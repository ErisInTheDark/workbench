/*
 * Exports:
 * - WorkbenchProviderInteractionResponse: accepted interaction with an optional persistence warning.
 * - WorkbenchProviderInteractions: provider delivery mechanics using WB identities.
 */
import type { WorkbenchUserInputResponse, WorkbenchPendingUserInputRequest } from "../../types.ts";
import type { WorkbenchQuestionnaireHistoryEntryState } from "../thread/thread-state.ts";
import type { WorkbenchUserInput } from "./provider-input.ts";

export interface WorkbenchProviderInteractionResponse { warning?: string }

export interface WorkbenchProviderInteractions {
  pending(): Promise<WorkbenchPendingUserInputRequest[]>;
  interruptRetaining(input: { threadId: string; turnId: string | null; requestKey: string }, isCurrent: () => Promise<boolean>): Promise<boolean>;
  canDeliver(threadId: string, requestKey: string): Promise<boolean>;
  deliver(input: { threadId: string; requestKey: string; response: WorkbenchUserInputResponse }): Promise<boolean>;
  respond(input: {
    threadId: string;
    turnId: string | null;
    requestKey: string;
    response: WorkbenchUserInputResponse;
    insertAfterItemId: string | null;
    insertAfterItemIndex: number | null;
  }): Promise<WorkbenchProviderInteractionResponse>;
  supplement(input: {
    threadId: string;
    turnId: string;
    input: WorkbenchUserInput[];
    activatedSkillPaths: string[];
  }): Promise<void>;
  record(entry: WorkbenchQuestionnaireHistoryEntryState): Promise<WorkbenchProviderInteractionResponse>;
}
