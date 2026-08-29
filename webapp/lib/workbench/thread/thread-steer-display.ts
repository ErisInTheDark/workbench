/*
 * Exports:
 * - unwrapWorkbenchSteerDisplayText/unwrapWorkbenchSteerDisplayInput: remove every registered UI-visible Workbench steer wrapper while preserving transport text. Keywords: steer, display, unwrap, registry.
 */

import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import { stripWorkbenchActivatedSkillsInput } from "./thread-activated-skills.ts";
import { WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER } from "./thread-agent-message.ts";
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
  return stripWorkbenchActivatedSkillsInput(input).map((item) => {
    if (item.type !== "text") return item;
    const text = unwrapWorkbenchSteerDisplayText(item.text);
    return text === item.text ? item : { ...item, text, text_elements: [] };
  });
}
