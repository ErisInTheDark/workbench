/*
 * Exports:
 * - default createLegacyThreadSource: adapt one document-fed `WorkbenchThreadController` to the thread store slices (pass 1; deleted with the document pipeline).
 */
import type { ThreadPayload, WorkbenchSubagentSummary } from "workbench-shared/types";
import { getWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import type WorkbenchThreadController from "../WorkbenchThreadController";
import type { ThreadControllerSnapshot } from "../WorkbenchThreadController";
import { createThreadTurnsSlice, type ThreadHead, type ThreadStoreSource, type ThreadStoreState } from "./ThreadStore";

function head(document: ThreadPayload | null): ThreadHead | null {
  if (!document) return null;
  return {
    ...(document.isDraft ? { id: document.id, isDraft: true as const } : { id: document.id, isDraft: false as const }),
    harness: document.harness, name: document.name, cwd: document.cwd, status: document.status,
    agentNickname: document.agentNickname, agentRole: document.agentRole, model: document.model, reasoningEffort: document.reasoningEffort,
    serviceTier: document.serviceTier, agentPath: document.agentPath, tokenUsage: document.tokenUsage,
    ...(document.contextWindowTokens !== undefined ? { contextWindowTokens: document.contextWindowTokens } : {}),
    ...(document.willAutoCompact !== undefined ? { willAutoCompact: document.willAutoCompact } : {}),
  };
}

function project(snapshot: ThreadControllerSnapshot): ThreadStoreState {
  return {
    summary: {
      status: snapshot.status, error: snapshot.error, head: head(snapshot.document), entry: snapshot.entry,
      subagents: snapshot.subagents, rateLimits: snapshot.rateLimits, gitArcProposals: snapshot.gitArcProposals,
      relatedHeads: Object.fromEntries(Object.entries(snapshot.relatedDocuments).map(([id, document]) => [id, head(document)!])),
      legacyDocument: snapshot.document,
    },
    turns: createThreadTurnsSlice(snapshot.transcript, Boolean(snapshot.document?.nextPageCursor)),
    questionnaire: { pending: snapshot.pendingQuestionnaire },
    approvals: { entries: snapshot.approvalEntries },
  };
}

export default function createLegacyThreadSource(
  owner: WorkbenchThreadController,
  publish: (next: Partial<ThreadStoreState>) => void,
  findSubagent: (subagents: readonly WorkbenchSubagentSummary[], threadId: string) => WorkbenchSubagentSummary | undefined,
): ThreadStoreSource {
  // The store mirrors the owner for its whole life, so reads before any lease (or without one) stay current.
  const sync = () => publish(project(owner.getSnapshot()));
  const unsubscribe = owner.subscribe(sync);
  sync();
  return {
    feed: "legacy",
    legacyOwner: owner,
    actions: {
      send: () => Promise.reject(new Error("Legacy threads send through the document flow.")),
      stop: async () => { await owner.actions.stop(); },
      compact: async () => { await owner.actions.compact(); },
      resendSteer: itemId => owner.actions.resendSteer(itemId),
      dismissSteer: itemId => owner.actions.dismissSteer(itemId),
      stopShell: itemId => owner.actions.stopShell(itemId),
      submitQuestionnaire: (response, options) => owner.actions.submitQuestionnaire(response, options),
      snoozeQuestionnaire: requestKey => owner.actions.snoozeQuestionnaire(requestKey),
      changeAgent: value => owner.actions.changeAgent(value),
      changeModel: value => owner.actions.changeModel(value),
      changeReasoningEffort: value => owner.actions.changeReasoningEffort(value),
      changeServiceTier: value => owner.actions.changeServiceTier(value),
      changeSettings: value => owner.actions.changeSettings(value),
      loadOlder: async () => {
        const { document, subagents } = owner.getSnapshot();
        if (!document?.nextPageCursor) return null;
        const cwd = findSubagent(subagents, document.id)?.cwd.trim();
        const payload = await owner.actions.read(document.harness, { ...(cwd ? { cwd } : {}), cursor: document.nextPageCursor });
        return payload ? payload.turns.filter(turn => getWorkbenchTurnAdmission(turn) !== "connecting").map(({ id }) => id) : null;
      },
      observeGitArcProposal: proposalId => owner.observeGitArcProposal(proposalId),
    },
    acquire(interest) {
      const release = owner.acquire(interest);
      sync();
      return release;
    },
    recover: () => owner.recover(),
    dispose: unsubscribe,
  };
}
