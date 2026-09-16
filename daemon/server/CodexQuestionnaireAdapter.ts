/*
 * Exports:
 * - CodexQuestionnairePort: native questionnaire view consumed by the Codex bridge.
 * - default CodexQuestionnaireAdapter: translate Codex references around the shared WB waiter without owning its lifecycle.
 */
import type { WorkbenchPendingUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import { ThreadReferenceSchema, TurnReferenceSchema, type NativeThreadId, type NativeTurnId } from "workbench-shared/workbench/identity";
import type WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import type { WorkbenchQuestionnaire } from "./WorkbenchQuestionnaireController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";

type NativeAnswer = Omit<WorkbenchQuestionnaire, "turnId"> & {
  turnId: NativeTurnId | null;
  threadId: NativeThreadId;
  response: WorkbenchUserInputResponse;
};

export interface CodexQuestionnairePort {
  list(): { data: Omit<WorkbenchPendingUserInputRequest, "harness">[] } | Promise<{ data: Omit<WorkbenchPendingUserInputRequest, "harness">[] }>;
  respond(input: { threadId: NativeThreadId; requestKey: string; response: WorkbenchUserInputResponse }): Promise<NativeAnswer | null>;
}

export default class CodexQuestionnaireAdapter implements CodexQuestionnairePort {
  constructor(
    private readonly questionnaires: Pick<WorkbenchQuestionnaireController, "list" | "respond">,
    private readonly threads: WorkbenchThreadIdentityController,
  ) {}

  async list() {
    const data: Omit<WorkbenchPendingUserInputRequest, "harness">[] = [];
    for (const pending of this.questionnaires.list().data) {
      const thread = await this.threads.resolve({ threadId: ThreadReferenceSchema.parse(pending.threadId) });
      if (!thread) {
        console.warn("[codex-questionnaire] Pending questionnaire has no admitted Workbench thread.");
        continue;
      }
      const binding = thread?.bindings.find(binding => binding.harness === "codex");
      if (!binding) continue;
      const turn = pending.turnId === null ? null : await this.threads.resolveTurn({
        threadId: thread.threadId, turnId: TurnReferenceSchema.parse(pending.turnId),
      });
      data.push({
        ...pending,
        threadId: binding.nativeThreadId,
        turnId: turn?.native.harness === "codex" && turn.native.nativeThreadId === binding.nativeThreadId
          ? turn.native.nativeTurnId : null,
      });
    }
    return { data };
  }

  async respond(input: Parameters<CodexQuestionnairePort["respond"]>[0]) {
    const thread = await this.threads.resolve({ harness: "codex", threadId: input.threadId });
    if (!thread) return null;
    const answered = await this.questionnaires.respond({ ...input, threadId: thread.threadId });
    if (!answered) return null;
    const turn = answered.turnId === null ? null : await this.threads.resolveTurn({
      threadId: thread.threadId, turnId: answered.turnId,
    });
    return {
      ...answered, threadId: input.threadId,
      turnId: turn?.native.harness === "codex" && turn.native.nativeThreadId === input.threadId
        ? turn.native.nativeTurnId : null,
    };
  }
}
