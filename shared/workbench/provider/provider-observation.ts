/*
 * Exports:
 * - WorkbenchTranscriptNotification: compatible public transcript messages.
 * - WorkbenchProviderLifecycleEvent: admitted lifecycle facts consumed by shared state.
 * - WorkbenchProviderObservation: lifecycle, turn-start and display-label facts from one provider ingress.
 * - isWorkbenchPublicNotification: recognise the public notification envelope at transport edges.
 */
import type { ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "../identity.ts";
import type { ThreadPayload, WorkbenchUserInputRequest } from "../../types.ts";
import type { WorkbenchDurableQuestionnaire, WorkbenchLifecycleEvent } from "../thread/thread-state.ts";
import type { FileUpdateChange, ThreadItem } from "../thread/workbench-thread-items.ts";
import type { ThreadStatus, Turn } from "../thread/workbench-thread-turn.ts";
import type { WorkbenchProviderGoal } from "./provider-goal.ts";
import type { WorkbenchRateLimitSnapshot } from "./provider-account.ts";
import type { ThreadTokenUsage } from "../thread/thread-context-usage.ts";
import type { WorkbenchThreadSkill } from "../thread/thread-skill-state.ts";

type ItemReference = { threadId: string; turnId: string; itemId: string };
const publicMethods = new Set<string>([
  "thread/started", "thread/status/changed", "thread/name/updated", "thread/tokenUsage/updated",
  "thread/goal/updated", "thread/goal/cleared", "thread/skills/updated", "account/updated", "account/rateLimits/updated", "models/updated",
  "turn/started", "turn/completed", "item/started", "item/completed",
  "item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "questionnaire/requested", "questionnaire/resolved", "browse/result/recorded",
] satisfies WorkbenchTranscriptNotification["method"][]);

export function isWorkbenchPublicNotification(message: unknown): message is WorkbenchTranscriptNotification {
  return !!message && typeof message === "object"
    && "method" in message && typeof message.method === "string" && publicMethods.has(message.method)
    && "params" in message && !!message.params && typeof message.params === "object"
    && !("id" in message);
}

export type WorkbenchTranscriptNotification =
  | { method: "thread/started"; params: { thread: ThreadPayload } }
  | { method: "thread/tokenUsage/updated"; params: { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage } }
  | { method: "account/updated"; params: object }
  | { method: "account/rateLimits/updated"; params: { rateLimits: WorkbenchRateLimitSnapshot } }
  | { method: "models/updated"; params: Record<string, never> }
  | { method: "thread/goal/updated"; params: { threadId: string; turnId?: string | null; goal: WorkbenchProviderGoal } }
  | { method: "thread/goal/cleared"; params: { threadId: string; turnId?: string | null } }
  | { method: "thread/skills/updated"; params: { threadId: string; skills: WorkbenchThreadSkill[] } }
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
  | { kind: "inputResolved"; requestKey: string; answered?: true }
  | { kind: "pendingInput"; questionnaire: WorkbenchDurableQuestionnaire | null; requestKey: string; turnId: WorkbenchTurnId | null };

export type WorkbenchProviderObservation = {
  accountLimits?: WorkbenchRateLimitSnapshot;
  projectId?: ProjectId;
  lifecycle: { event: WorkbenchProviderLifecycleEvent; threadId: WorkbenchThreadId } | null;
  /** Orders the sidebar thread only; activity time is owned by admitted transcript items. */
  turnStarted: { startedAt: number | null; threadId: WorkbenchThreadId } | null;
  displayLabel: { threadId: WorkbenchThreadId; label: string } | null;
};
