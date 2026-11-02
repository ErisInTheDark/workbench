/*
 * No production exports. Tests instruction layers: a later layer replaces modes and checklists by name.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mergeWorkbenchInstructionLayers, readWorkbenchInstructionLayer } from "./instruction-overlay-catalogue";

const checklist = (label: string) => `<proof-of-work id="plan">\n- [ ] **${label} [plan.result]:** x\n</proof-of-work>`;

test("a later layer replaces an earlier mode or checklist of the same name; others survive", () => {
  const overlays = mergeWorkbenchInstructionLayers([
    `<mode name="Review" icon="flag" proofs="review" deny="shell" />\n<mode name="Brief" proofs="plan" />\n${checklist("Base")}`,
    `<mode name="review" icon="flag" />\n${checklist("Project")}`,
  ].map(readWorkbenchInstructionLayer));
  assert.deepEqual(overlays.modes.map(mode => [mode.name, mode.proofs, mode.deny]), [["Brief", ["plan"], []], ["review", [], []]]);
  assert.deepEqual(overlays.checklists.map(entry => entry.items[0]?.label), ["Project"]);
});
