/*
 * Exports:
 * - DraftThreadSourcePorts: the client-owned draft document, its change signal, account limits and draft settings controls.
 * - default createDraftThreadSource: own a draft's local launch preview and feed its document and account state.
 */
import type { ThreadPayload, WorkbenchControls, WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchRateLimitSnapshot } from "workbench-shared/workbench/provider/provider-account";
import type { DraftId } from "workbench-shared/workbench/identity";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import { EMPTY_THREAD_STORE_STATE, type ThreadHead, type ThreadStoreSource, type ThreadStoreState } from "./ThreadStore";
import { createOptimisticItem } from "./thread-optimistic-items";

export interface DraftThreadSourcePorts {
  projectId: string;
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

function projectLaunch(draft: ThreadPayload, turn: Turn, projectId: string): WorkbenchTranscriptProjection {
  return {
    thread: {
      id: draft.id, projectId, projectRoot: draft.cwd, cwd: draft.cwd, title: draft.name ?? "",
      createdAt: draft.createdAt, updatedAt: draft.updatedAt, activityAt: draft.updatedAt,
    },
    turns: [{ ...turn, turnIndex: 0, itemTimeline: [] }],
    turnHistory: [], hasPreviousTurns: false,
    approvalEntries: [], browseResultEntries: [], questionnaireEntries: [], steerEntries: [],
    display: planCanonicalTranscriptDisplay({
      turns: [{ turnId: turn.id, turnIndex: 0 }], items: [],
      virtualTail: turn.items.map(payload => ({ turnId: turn.id, payload })),
    }),
  };
}

export default function createDraftThreadSource(
  ports: DraftThreadSourcePorts,
  publish: (next: Partial<ThreadStoreState>) => void,
): ThreadStoreSource {
  let leases = 0;
  let disposed = false;
  let launchTurn: Turn | null = null;
  let stayInCreate = false;
  const sync = () => {
    if (disposed) return;
    const draft = ports.readDraft();
    if (draft && leases) ports.watchRateLimits(draft.harness);
    publish({
      summary: {
        ...EMPTY_THREAD_STORE_STATE.summary,
        status: draft ? "ready" : "loading",
        head: draft ? { ...headOf(draft), status: launchTurn && !stayInCreate ? "active" : draft.status } : null,
        rateLimits: draft ? ports.readRateLimits(draft.harness) : null,
        draftDocument: draft,
      },
      turns: {
        ...EMPTY_THREAD_STORE_STATE.turns,
        transcript: draft && launchTurn && !stayInCreate
          ? { status: "ready", threadId: draft.id, projection: projectLaunch(draft, launchTurn, ports.projectId) }
          : EMPTY_THREAD_STORE_STATE.turns.transcript,
        turns: launchTurn && !stayInCreate ? [launchTurn] : EMPTY_THREAD_STORE_STATE.turns.turns,
        liveTurnId: stayInCreate ? null : launchTurn?.id ?? null,
      },
    });
  };
  // The draft document is client state: mirror it for the store's whole life, so reads without a lease stay current.
  const unsubscribe = ports.subscribe(sync);
  sync();
  return {
    feed: "draft",
    actions: {
      async submitDraft(input, submit, options) {
        if (disposed || launchTurn) return false;
        stayInCreate = options?.stayInCreate === true;
        const id = crypto.randomUUID();
        const item = createOptimisticItem({
          clientUserMessageId: null, handle: id, input, placement: "initial", status: "pending",
        });
        launchTurn = {
          id, status: "inProgress", itemsView: "full", error: null,
          startedAt: Date.now() / 1000, completedAt: null, durationMs: null,
          items: [item],
        };
        sync();
        let accepted = false;
        const accept = () => {
          if (accepted) return;
          accepted = true;
          if (!disposed && launchTurn) {
            launchTurn = {
              ...launchTurn,
              items: [{ type: item.type, id: item.id, clientId: item.clientId, content: item.content }],
            };
            sync();
          }
        };
        try {
          if (await submit(accept)) accept();
          return accepted;
        } finally {
          if (!accepted) launchTurn = null;
          sync();
        }
      },
      // Drafts launch through the app's saved-draft flow (the view sends with the draft document).
      send: unsupported("send directly"),
      stop: async () => {},
      compact: async () => {},
      resendSteer: unsupported("resend a steer"),
      dismissSteer: unsupported("dismiss a steer"),
      stopShell: unsupported("stop a command"),
      submitQuestionnaire: unsupported("answer a question"),
      snooze: unsupported("snooze a thread"),
      changeAgent: value => ports.controls.setCurrentThreadAgent(ports.draftId, value),
      changeModel: value => ports.controls.setCurrentThreadModel(ports.draftId, value),
      changeReasoningEffort: value => ports.controls.setCurrentThreadReasoningEffort(ports.draftId, value),
      changeServiceTier: value => ports.controls.setCurrentThreadServiceTier(ports.draftId, value),
      changeSettings: value => ports.controls.setCurrentThreadComposerSettings(ports.draftId, value),
      loadOlder: async () => null,
      observeGitArcProposal: () => () => {},
      observeGitArcClaimChanges: () => () => {},
      refreshGitArcClaimChanges: () => {},
      setGoal: unsupported("set a goal"),
      clearGoal: unsupported("clear a goal"),
      deactivateSkill: unsupported("deactivate a skill"),
      addTodo: unsupported("add a todo"),
      removeTodo: unsupported("remove a todo"),
      setTodoRequired: unsupported("change a todo"),
      setTodoText: unsupported("edit a todo"),
      clearAddressedFeedback: unsupported("clear addressed feedback"),
    },
    acquire() {
      leases++;
      sync();
      let released = false;
      return () => { if (!released) { released = true; leases--; } };
    },
    recover: async () => {},
    dispose() {
      disposed = true;
      launchTurn = null;
      unsubscribe();
    },
  };
}
