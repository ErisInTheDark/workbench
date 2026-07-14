/*
 * Exports:
 * - WORKBENCH_THREAD_RECOVERY_MESSAGE/WORKBENCH_THREAD_RECOVERY_ID_PREFIX: exact hidden continuation contract. Keywords: thread, recovery, message.
 * - createWorkbenchThreadRecoveryId/createWorkbenchThreadRecoveryInput: construct provider-safe recovery identity and input. Keywords: thread, recovery, id.
 * - isWorkbenchThreadRecoveryInput/isWorkbenchThreadRecoveryUserMessage: recognize only exact marked recovery content. Keywords: thread, recovery, hidden.
 * - isWorkbenchInterruptedThreadRecoveryEligible: recognize the manual Codex/OpenCode interrupted-turn action boundary. Keywords: thread, recovery, composer.
 */

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, getCurrentTurn } from "../../codex/thread-state";
import type { ThreadPayload } from "../../types";

export const WORKBENCH_THREAD_RECOVERY_MESSAGE = "An unavoidable Codex interruption occurred. Resume where you left off. It has not affected your context window, so there is no need to use thread recall or re-inspect due to the interruption.";
export const WORKBENCH_THREAD_RECOVERY_ID_PREFIX = "workbench:thread-recovery:";

function hashSeed(seed: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(36)}${right.toString(36)}`;
}

export function createWorkbenchThreadRecoveryId(seed?: string) {
  const identity = seed?.trim()
    ? hashSeed(seed)
    : typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${WORKBENCH_THREAD_RECOVERY_ID_PREFIX}${identity}`;
}

export function createWorkbenchThreadRecoveryInput(): UserInput[] {
  return [{ text: WORKBENCH_THREAD_RECOVERY_MESSAGE, text_elements: [], type: "text" }];
}

export function isWorkbenchThreadRecoveryInput(input: readonly UserInput[]) {
  return input.length === 1
    && input[0]?.type === "text"
    && input[0].text === WORKBENCH_THREAD_RECOVERY_MESSAGE;
}

export function isWorkbenchThreadRecoveryUserMessage(item: Extract<ThreadItem, { type: "userMessage" }>) {
  if (!isWorkbenchThreadRecoveryInput(item.content)) {
    return false;
  }
  return Boolean(
    item.clientId?.startsWith(WORKBENCH_THREAD_RECOVERY_ID_PREFIX)
    || item.id.startsWith(`opencode:user:${WORKBENCH_THREAD_RECOVERY_ID_PREFIX}`),
  );
}

export function isWorkbenchInterruptedThreadRecoveryEligible(
  thread: Pick<ThreadPayload, "harness" | "turns">,
  controlsMode: "comment" | "thread" = "thread",
) {
  return controlsMode === "thread"
    && (thread.harness === "codex" || thread.harness === "opencode")
    && getCurrentInProgressTurn(thread) === null
    && getCurrentTurn(thread)?.status === "interrupted";
}
