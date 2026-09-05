/*
 * Exports:
 * - WORKBENCH_THREAD_RECOVERY_MESSAGE/WORKBENCH_UNFINISHED_TURN_MESSAGE/WORKBENCH_THREAD_RECOVERY_ID_PREFIX: exact hidden continuation contracts. Keywords: thread, recovery, unfinished, message.
 * - createWorkbenchThreadRecoveryId/createWorkbenchThreadRecoveryInput/createWorkbenchUnfinishedTurnInput/createWorkbenchQuestionnaireResponseInput: construct provider-safe hidden Workbench steers. Keywords: thread, recovery, unfinished, questionnaire, id.
 * - isWorkbenchThreadRecoveryInput/isWorkbenchUnfinishedTurnInput/isWorkbenchQuestionnaireResponseInput/isWorkbenchHiddenSystemSteerInput/isWorkbenchThreadRecoveryUserMessage: recognize exact hidden Workbench content by text. Keywords: thread, recovery, unfinished, questionnaire, hidden.
 * - isWorkbenchThreadRecoveryEligible: derive the manual resume boundary from authoritative lifecycle and pending-input state. Keywords: thread, recovery, composer, lifecycle.
 */

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput.ts";
import { getCurrentInProgressTurn } from "../../codex/thread-state.ts";
import type { ThreadPayload, WorkbenchUserInputResponse } from "../../types.ts";
import { defineTagWrapper } from "./tag-wrapper.ts";
import { stripWorkbenchActivatedSkillsInput } from "./thread-activated-skills.ts";
import type { WorkbenchThreadLifecycle } from "./thread-state.ts";

export const WORKBENCH_THREAD_RECOVERY_MESSAGE = "<wb:resume />";
export const WORKBENCH_UNFINISHED_TURN_MESSAGE = `<wb:resume>
You inappropriately ended the turn without finishing the task. The correct next action could be: 
1. continuing your work or
2. sending a questionnaire or
3. setting the thread status to blocked or completed before ending.
Determine the correct action. Do not commentate on this resumption. Do not repeat this mistake.
</wb:resume>`;
export const WORKBENCH_THREAD_RECOVERY_ID_PREFIX = "workbench:thread-recovery:";
const WORKBENCH_QUESTIONNAIRE_RESPONSE_TAG_WRAPPER = defineTagWrapper("wb:questionnaire-response", {
  attributes: [],
});

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

export function createWorkbenchUnfinishedTurnInput(): UserInput[] {
  return [{ text: WORKBENCH_UNFINISHED_TURN_MESSAGE, text_elements: [], type: "text" }];
}

export function createWorkbenchQuestionnaireResponseInput(response: WorkbenchUserInputResponse): UserInput[] {
  return [{
    text: WORKBENCH_QUESTIONNAIRE_RESPONSE_TAG_WRAPPER.wrap(JSON.stringify(response, null, 2), {}),
    text_elements: [],
    type: "text",
  }];
}

export function isWorkbenchThreadRecoveryInput(input: readonly UserInput[]) {
  return input.length === 1
    && input[0]?.type === "text"
    && (
      input[0].text === WORKBENCH_THREAD_RECOVERY_MESSAGE
      || input[0].text === WORKBENCH_UNFINISHED_TURN_MESSAGE
    );
}

export function isWorkbenchUnfinishedTurnInput(input: readonly UserInput[]) {
  return input.length === 1
    && input[0]?.type === "text"
    && input[0].text === WORKBENCH_UNFINISHED_TURN_MESSAGE;
}

export function isWorkbenchQuestionnaireResponseInput(input: readonly UserInput[]) {
  const visibleInput = stripWorkbenchActivatedSkillsInput(input);
  if (visibleInput.length !== 1 || visibleInput[0]?.type !== "text") return false;
  const parsed = WORKBENCH_QUESTIONNAIRE_RESPONSE_TAG_WRAPPER.read(visibleInput[0].text);
  if (!parsed) return false;
  try {
    const response = JSON.parse(parsed.body) as { answers?: unknown };
    return Boolean(response) && typeof response === "object" && response.answers !== null && typeof response.answers === "object";
  } catch {
    return false;
  }
}

export function isWorkbenchHiddenSystemSteerInput(input: readonly UserInput[]) {
  return isWorkbenchThreadRecoveryInput(input) || isWorkbenchQuestionnaireResponseInput(input);
}

export function isWorkbenchThreadRecoveryUserMessage(item: Extract<ThreadItem, { type: "userMessage" }>) {
  return isWorkbenchThreadRecoveryInput(item.content);
}

export function isWorkbenchThreadRecoveryEligible(
  thread: Pick<ThreadPayload, "turns">,
  lifecycle: WorkbenchThreadLifecycle | null,
  hasPendingUserInput: boolean,
  controlsMode: "comment" | "thread" = "thread",
) {
  return controlsMode === "thread"
    && !hasPendingUserInput
    && getCurrentInProgressTurn(thread) === null
    && Boolean(
      (lifecycle?.kind === "needsAttention" && lifecycle.reason === "noActiveTurn")
      || lifecycle?.kind === "stopped",
    );
}
