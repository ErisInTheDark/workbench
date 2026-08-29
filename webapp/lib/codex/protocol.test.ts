/*
 * No production exports. Node tests protect Codex questionnaire collaboration transport from duplicating Workbench instructions. Keywords: Codex, questionnaire, collaboration, instructions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createQuestionnaireCollaborationMode } from "./protocol";

test("questionnaire collaboration mode carries no developer instruction copy", () => {
  assert.deepEqual(createQuestionnaireCollaborationMode("gpt-test", "high"), {
    mode: "plan",
    settings: {
      developer_instructions: "",
      model: "gpt-test",
      reasoning_effort: "high",
    },
  });
});
