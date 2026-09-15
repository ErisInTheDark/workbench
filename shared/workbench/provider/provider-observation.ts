/*
 * Exports:
 * - WorkbenchTranscriptNotification: compatible public transcript messages.
 * - WorkbenchProviderLifecycleEvent: admitted lifecycle facts consumed by shared state.
 * - WorkbenchProviderObservation: lifecycle, activity and title facts from one provider ingress.
 */
import type { ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "../identity.ts";
import type { WorkbenchUserInputRequest } from "../../types.ts";
import type { WorkbenchDurableQuestionnaire, WorkbenchLifecycleEvent } from "../thread/thread-state.ts";
import type { FileUpdateChange, ThreadItem } from "../thread/workbench-thread-items.ts";
import type { ThreadStatus, Turn } from "../thread/workbench-thread-turn.ts";

type ItemReference = { threadId: string; turnId: string; itemId: string };
export type WorkbenchTranscriptNotification =
  | { method: "turn/started"; params: { threadId: string; turn: Turn } }
  | { method: "turn/completed"; params: { threadId: string; turn: Turn } }
  | { method: "item/started"; params: { threadId: string; turnId: string; item: ThreadItem; startedAtMs: number } }
  | { method: "item/completed"; params: { threadId: string; turnId: string; item: ThreadItem; completedAtMs: number } }
  | { method: "item/agentMessage/delta"; params: ItemReference & { delta: string } }
  | { method: "item/plan/delta"; params: ItemReference & { delta: string } }
  | { method: "item/commandExecution/outputDelta"; params: ItemReference & { delta: string } }
  | { method: "item/fileChange/outputDelta"; params: ItemReference & { delta: string } }
  | { method: "item/fileChange/patchUpdated"; params: ItemReference & { changes: FileUpdateChange[] } }
  | { method: "item/reasoning/summaryTextDelta"; params: ItemReference & { delta: string; summaryIndex: number } }
  | { method: "item/reasoning/summaryPartAdded"; params: ItemReference & { summaryIndex: number } }
  | { method: "item/reasoning/textDelta"; params: ItemReference & { delta: string; contentIndex: number } }
  | { method: "thread/status/changed"; params: { threadId: string; status: ThreadStatus } }
  | { method: "thread/name/updated"; params: { threadId: string; threadName?: string } }
  | { method: "questionnaire/requested"; params: {
    threadId: string; turnId: string | null; itemId: string | null; requestKey: string; request: WorkbenchUserInputRequest;
  } }
  | { method: "questionnaire/resolved"; params: { threadId: string; requestKey: string } }
  | { method: "browse/result/recorded"; params: { threadId: string; turnId: string } };

export type WorkbenchProviderLifecycleEvent =
  | Exclude<WorkbenchLifecycleEvent, { kind: "inputResolved" | "pendingInput" }>
  | { kind: "inputResolved"; requestKey: string }
  | { kind: "pendingInput"; questionnaire: WorkbenchDurableQuestionnaire | null; requestKey: string; turnId: WorkbenchTurnId | null };

export type WorkbenchProviderObservation = {
  projectId?: ProjectId;
  lifecycle: { event: WorkbenchProviderLifecycleEvent; threadId: WorkbenchThreadId } | null;
  activity:
    | { kind: "activity"; threadId: WorkbenchThreadId }
    | { kind: "turnStarted"; startedAt: number | null; threadId: WorkbenchThreadId }
    | null;
  title: { threadId: WorkbenchThreadId; title: string } | null;
};
