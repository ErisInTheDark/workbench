/*
 * No production exports. Tests every workflow denial sentence is recognised bare and inside provider or wrapper failure text,
 * and that ordinary failures are not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  describeCompactionEditDenial, describeModeEditDenial, describeModeToolDenial, isWorkflowDenialText, PRE_MODE_DENIAL,
} from "./workflow-denials";

test("every workflow denial is recognised bare and wrapped", () => {
  const denials = [
    PRE_MODE_DENIAL,
    describeModeToolDenial("Review", "rg"),
    describeModeEditDenial("Inspect", "edits to Git-visible files", ["src/a.ts"]),
    describeCompactionEditDenial({ recall: true, proofs: ["compaction.narrative"] }),
  ];
  for (const denial of denials) {
    for (const text of [denial, `Workbench shell failed: ${denial}`, `PreToolUse:Read hook error: ${denial}`]) {
      assert.equal(isWorkflowDenialText(text), true, text);
    }
  }
});

test("ordinary failures are not workflow denials", () => {
  for (const text of ["Command failed with exit code 1.", "Unclaimed file changes: src/a.ts.", "the model denies nothing", ""]) {
    assert.equal(isWorkflowDenialText(text), false, text);
  }
});
