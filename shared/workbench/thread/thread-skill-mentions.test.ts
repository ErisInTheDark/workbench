/*
 * No production exports. Tests protect shared skill mention rules and the daemon's skill activation check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkbenchSkillActivations, readWorkbenchSkillActivationMismatch, readWorkbenchSkillMentionPaths,
  WorkbenchSkillActivationMismatchError,
} from "./thread-skill-mentions.ts";

const skill = (name: string, dir: string) => ({
  name, description: "", path: `C:/skills/${dir}/SKILL.md`, relativePath: `skills/${dir}/SKILL.md`,
});
const review = skill("Code Review", "review");
const browse = skill("browse", "browse");
const browseCopy = skill("browse", "browse-copy");

test("skills are named by unique name or folder after a boundary, ignoring trailing punctuation", () => {
  assert.deepEqual(readWorkbenchSkillMentionPaths(["please /review, then /CODE"], [review]), [review.path]);
  assert.deepEqual(readWorkbenchSkillMentionPaths(["see C:/review and x/review"], [review]), [], "mid-word slashes name nothing");
  assert.deepEqual(readWorkbenchSkillMentionPaths(["/browse"], [browse, browseCopy]), [], "ambiguous names activate nothing");
  assert.deepEqual(readWorkbenchSkillMentionPaths(["/browse-copy."], [browse, browseCopy]), [browseCopy.path]);
});

test("mentions inside hidden Workbench blocks never count; only typed text does", () => {
  const todo = `<wb:todo id="1" required="true" created="1">\nuse /review here\n</wb:todo>`;
  const answer = `<wb:questionnaire-response>\n{"answers":{"q":{"answers":["try /review"]}}}\n</wb:questionnaire-response>`;
  assert.deepEqual(readWorkbenchSkillMentionPaths([`${todo}\n\nplain message`], [review]), []);
  assert.deepEqual(readWorkbenchSkillMentionPaths([`${answer}\n\nthen /browse`], [review, browse]), [browse.path]);
});

test("claimed activations must equal the skills the message names", () => {
  assert.doesNotThrow(() => assertWorkbenchSkillActivations([review.path], ["/review"], [review]));
  const unknown = (() => {
    try { assertWorkbenchSkillActivations(["C:/gone/stale/SKILL.md"], ["/stale"], [review]); }
    catch (error) { return error; }
  })();
  assert.ok(unknown instanceof WorkbenchSkillActivationMismatchError);
  assert.deepEqual(unknown.mismatch.unknownPaths, ["C:/gone/stale/SKILL.md"]);
  assert.match(unknown.message, /\/stale doesn't exist/u);
  assert.throws(() => assertWorkbenchSkillActivations([], ["/review"], [review]), /\/Code Review is available but wasn't activated/u);
});

test("rejection data survives the daemon error envelope", () => {
  const mismatch = { unknownPaths: ["x"], missedPaths: [], activatableSkills: [review] };
  assert.deepEqual(readWorkbenchSkillActivationMismatch({ data: { skillActivationMismatch: mismatch } }), mismatch);
  assert.equal(readWorkbenchSkillActivationMismatch(new Error("other")), null);
});
