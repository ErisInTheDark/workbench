/*
 * Exports:
 * - WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER: exact model-visible and UI-hidden activated-skill wrapper. Keywords: skills, input, hidden.
 * - WORKBENCH_SKILL_DEACTIVATED_TAG_WRAPPER: hidden notice that the user deactivated one skill.
 * - createWorkbenchActivatedSkillsInput: append fresh activated skill bodies as one user input item. Keywords: skills, user input, transport.
 * - createWorkbenchPreviouslyActivatedSkillsText: re-send active skill bodies after context compaction.
 * - createWorkbenchSkillDeactivatedText: tell the agent the user deactivated one skill.
 * - WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER/createWorkbenchSkillsChangedText: hidden notice of skill list changes since the agent was last told.
 * - isWorkbenchActivatedSkillsInput/stripWorkbenchActivatedSkillsInput: recognize and remove only the exact hidden item for display. Keywords: skills, display, strip.
 */

import type { UserInput } from "./workbench-thread-items.ts";
import { defineTagWrapper } from "./tag-wrapper.ts";

export const WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER = defineTagWrapper("wb:activated-skills", {
  attributes: [],
});

export const WORKBENCH_SKILL_DEACTIVATED_TAG_WRAPPER = defineTagWrapper("wb:skill-deactivated", {
  attributes: ["name"],
});

export const WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER = defineTagWrapper("wb:skills-changed", {
  attributes: [],
});

const PREVIOUSLY_ACTIVATED_NOTE = "These skills were previously activated in this thread. They may no longer be active. Use thread recall if you're unsure.";

export function createWorkbenchActivatedSkillsInput(skillCatalog: string): Extract<UserInput, { type: "text" }> {
  return {
    text: WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.wrap(skillCatalog.trim(), {}),
    text_elements: [],
    type: "text",
  };
}

export function createWorkbenchPreviouslyActivatedSkillsText(skillCatalog: string) {
  return WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.wrap(`${PREVIOUSLY_ACTIVATED_NOTE}\n${skillCatalog.trim()}`, {});
}

export function createWorkbenchSkillDeactivatedText(name: string) {
  return WORKBENCH_SKILL_DEACTIVATED_TAG_WRAPPER.wrap(
    "The user deactivated this skill. Stop applying its instructions unless it is activated again.",
    { name },
  );
}

/** `changed` holds catalog entries, with full bodies for active skills; `removed` names skills that no longer exist. */
export function createWorkbenchSkillsChangedText(changed: string | null, removed: readonly string[]) {
  return WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER.wrap([
    "Workbench skills changed since you were last told.",
    ...changed?.trim() ? ["Added or changed:", changed.trim()] : [],
    ...removed.length ? [`Removed: ${removed.join(", ")}`] : [],
  ].join("\n"), {});
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
