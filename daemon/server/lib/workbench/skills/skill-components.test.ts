/* No production exports. Protect component declarations independently of skill body text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSkillComponentPaths } from "./skill-components";

test("component files come only from the skill's frontmatter list", () => {
  const skill = [
    "---",
    "name: cards",
    "workbench_components:",
    "  - TrelloCard.tsx",
    "  - 'OtherCard.tsx'",
    "---",
    "  - NotAComponent.tsx",
  ].join("\n");
  assert.deepEqual(readSkillComponentPaths(skill), ["TrelloCard.tsx", "OtherCard.tsx"]);
  assert.deepEqual(readSkillComponentPaths("no frontmatter"), []);
});

test("component lists accept ordinary YAML comments on quoted paths", () => {
  assert.deepEqual(readSkillComponentPaths([
    "---",
    "workbench_components: # cards",
    '  - "TrelloCard.tsx" # main card',
    "  - 'OtherCard.tsx' # alternate card",
    "---",
  ].join("\n")), ["TrelloCard.tsx", "OtherCard.tsx"]);
  assert.deepEqual(readSkillComponentPaths('---\nworkbench_components: [Card.tsx] # one card\n---\n'), ["Card.tsx"]);
});
