/*
 * Exports:
 * - WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER: exact model-visible and UI-hidden activated-skill wrapper. Keywords: skills, input, hidden.
 * - createWorkbenchActivatedSkillsInput: append fresh activated skill bodies as one user input item. Keywords: skills, user input, transport.
 * - isWorkbenchActivatedSkillsInput/stripWorkbenchActivatedSkillsInput: recognize and remove only the exact hidden item for display. Keywords: skills, display, strip.
 */

import type { UserInput } from "../../codex/generated/app-server/v2/UserInput.ts";
import { defineTagWrapper } from "./tag-wrapper.ts";

export const WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER = defineTagWrapper("wb:activated-skills", {
  attributes: [],
});

export function createWorkbenchActivatedSkillsInput(skillCatalog: string): Extract<UserInput, { type: "text" }> {
  return {
    text: WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.wrap(skillCatalog.trim(), {}),
    text_elements: [],
    type: "text",
  };
}

export function isWorkbenchActivatedSkillsInput(
  input: UserInput,
): input is Extract<UserInput, { type: "text" }> {
  return input.type === "text"
    && WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.read(input.text) !== null;
}

export function stripWorkbenchActivatedSkillsInput(input: readonly UserInput[]): UserInput[] {
  return input.filter((item) => !isWorkbenchActivatedSkillsInput(item));
}
