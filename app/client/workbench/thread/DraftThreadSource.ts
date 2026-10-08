/*
 * Exports:
 * - DraftThreadSourcePorts: the client-owned draft document, its change signal, account limits and draft settings controls.
 * - default createDraftThreadSource: feed a draft's thread store from its local draft document; drafts have no daemon channels until their first send launches a thread.
 */
import type { ThreadPayload, WorkbenchControls, WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchRateLimitSnapshot } from "workbench-shared/workbench/provider/provider-account";
import type { DraftId } from "workbench-shared/workbench/identity";
import { EMPTY_THREAD_STORE_STATE, type ThreadHead, type ThreadStoreSource, type ThreadStoreState } from "./ThreadStore";

export interface DraftThreadSourcePorts {
  draftId: DraftId;
  readDraft: () => ThreadPayload | null;
  subscribe: (listener: () => void) => () => void;
  readRateLimits: (harness: WorkbenchHarness) => WorkbenchRateLimitSnapshot | null;
  watchRateLimits: (harness: WorkbenchHarness) => void;
  controls: Pick<WorkbenchControls, "setCurrentThreadAgent" | "setCurrentThreadModel" | "setCurrentThreadReasoningEffort" | "setCurrentThreadServiceTier" | "setCurrentThreadComposerSettings">;
}

function headOf(draft: ThreadPayload): ThreadHead {
  return {
    ...(draft.isDraft ? { id: draft.id, isDraft: true as const } : { id: draft.id, isDraft: false as const }),
    harness: draft.harness, name: draft.name, cwd: draft.cwd, status: draft.status,
    agentNickname: draft.agentNickname, agentRole: draft.agentRole,
    model: draft.model, reasoningEffort: draft.reasoningEffort, serviceTier: draft.serviceTier, agentPath: draft.agentPath,
    tokenUsage: null, contextWindowTokens: draft.contextWindowTokens ?? null,
  };
}

const unsupported = (action: string) => () => Promise.reject(new Error(`A draft cannot ${action} before it is launched.`));

export default function createDraftThreadSource(
  ports: DraftThreadSourcePorts,
  publish: (next: Partial<ThreadStoreState>) => void,
): ThreadStoreSource {
  let leases = 0;
  const sync = () => {
    const draft = ports.readDraft();
    if (draft && leases) ports.watchRateLimits(draft.harness);
    publish({
      summary: {
        ...EMPTY_THREAD_STORE_STATE.summary,
        status: draft ? "ready" : "loading",
        head: draft ? headOf(draft) : null,
        rateLimits: draft ? ports.readRateLimits(draft.harness) : null,
        draftDocument: draft,
      },
    });
  };
  // The draft document is client state: mirror it for the store's whole life, so reads without a lease stay current.
  const unsubscribe = ports.subscribe(sync);
  sync();
  return {
    feed: "draft",
    actions: {
      // Drafts launch through the app's saved-draft flow (the view sends with the draft document).
      send: unsupported("send directly"),
      stop: async () => {},
      compact: async () => {},
      resendSteer: unsupported("resend a steer"),
      dismissSteer: unsupported("dismiss a steer"),
      stopShell: unsupported("stop a command"),
      submitQuestionnaire: unsupported("answer a question"),
      snoozeQuestionnaire: unsupported("snooze a question"),
      changeAgent: value => ports.controls.setCurrentThreadAgent(ports.draftId, value),
      changeModel: value => ports.controls.setCurrentThreadModel(ports.draftId, value),
      changeReasoningEffort: value => ports.controls.setCurrentThreadReasoningEffort(ports.draftId, value),
      changeServiceTier: value => ports.controls.setCurrentThreadServiceTier(ports.draftId, value),
      changeSettings: value => ports.controls.setCurrentThreadComposerSettings(ports.draftId, value),
      loadOlder: async () => null,
      observeGitArcProposal: () => () => {},
      setGoal: unsupported("set a goal"),
      clearGoal: unsupported("clear a goal"),
      deactivateSkill: unsupported("deactivate a skill"),
    },
    acquire() {
      leases++;
      sync();
      let released = false;
      return () => { if (!released) { released = true; leases--; } };
    },
    recover: async () => {},
    dispose: unsubscribe,
  };
}
