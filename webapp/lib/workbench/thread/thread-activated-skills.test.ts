/*
 * No production exports. Tests protect the exact activated-skill transport wrapper and UI stripping boundary. Keywords: skills, input, hidden.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkbenchActivatedSkillsInput,
  isWorkbenchActivatedSkillsInput,
  stripWorkbenchActivatedSkillsInput,
} from "./thread-activated-skills.ts";
import {
  buildInlineMentionCandidates,
  getActivatedWorkbenchSkillPathsForTextValues,
} from "./inline-mention-highlights.ts";

test("activated skill bodies use one exact hidden user input item", () => {
  const activated = createWorkbenchActivatedSkillsInput(
    '<skill filename="C:/skills/iterate/SKILL.md" trigger="/iterate">\nDo the work.\n</skill>',
  );
  const visible = { text: "/iterate now", text_elements: [], type: "text" as const };

  assert.match(activated.text, /^<wb:activated-skills>\n<skill /u);
  assert.match(activated.text, /Do the work\.\n<\/skill>\n<\/wb:activated-skills>$/u);
  assert.equal(isWorkbenchActivatedSkillsInput(activated), true);
  assert.equal(isWorkbenchActivatedSkillsInput(visible), false);
  assert.deepEqual(stripWorkbenchActivatedSkillsInput([visible, activated]), [visible]);
});

test("independent custom text values resolve and dedupe activated skills", () => {
  const sources = buildInlineMentionCandidates({
    files: [],
    skills: [{
      description: "Use when the user says /iterate.",
      name: "iterate",
      path: "C:/skills/iterate/SKILL.md",
      relativePath: "skills/iterate/SKILL.md",
    }],
  });

  assert.deepEqual(getActivatedWorkbenchSkillPathsForTextValues([
    "first answer uses /iterate",
    "second answer repeats /iterate",
    "fixed option labels never enter this custom-text list",
  ], sources), ["C:/skills/iterate/SKILL.md"]);
});
