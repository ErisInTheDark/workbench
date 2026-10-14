/*
 * Exports:
 * - unwrapWorkbenchSteerDisplayText/unwrapWorkbenchSteerDisplayInput: remove hidden Workbench control input and unwrap UI-visible steer envelopes.
 */

import type { UserInput } from "./workbench-thread-items.ts";
import { stripWorkbenchActivatedSkillsInput } from "./thread-activated-skills.ts";
import { WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER } from "./thread-agent-message.ts";
import {
  isWorkbenchThreadRecoveryInput,
  stripWorkbenchQuestionnaireResponseInput,
} from "./thread-recovery-message.ts";
import { WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER } from "./thread-user-input-requests.ts";

interface WorkbenchSteerDisplayWrapper {
  unwrap(value: string): string;
}

const WORKBENCH_STEER_DISPLAY_WRAPPERS: readonly WorkbenchSteerDisplayWrapper[] = [
  WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER,
  WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER,
];

export function unwrapWorkbenchSteerDisplayText(value: string) {
  return WORKBENCH_STEER_DISPLAY_WRAPPERS.reduce(
    (unwrapped, wrapper) => wrapper.unwrap(unwrapped),
    value,
  );
}

export function unwrapWorkbenchSteerDisplayInput(input: readonly UserInput[]): UserInput[] {
  const displayInput = stripWorkbenchQuestionnaireResponseInput(stripWorkbenchActivatedSkillsInput(input));
  if (isWorkbenchThreadRecoveryInput(displayInput)) return [];
  return displayInput.map((item) => {
    if (item.type !== "text") return item;
    const text = unwrapWorkbenchSteerDisplayText(item.text);
    return text === item.text ? item : { ...item, text, text_elements: [] };
  });
}
