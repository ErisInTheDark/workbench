/*
 * No production exports. Tests instruction layers: a later layer replaces modes and checklists by name, and the bundled default and
 * subagent workflows, imports expanded, gate every mode on checklists their prompt declares.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mergeWorkbenchInstructionLayers, readWorkbenchInstructionLayer } from "./instruction-overlay-catalogue";
import { createInstructionFileGeneration } from "./instruction-file-generation";

const checklist = (label: string) => `<proof-of-work id="plan">\n- [ ] **${label} [plan.result]:** x\n</proof-of-work>`;
const instructionRoot = fileURLToPath(new URL("../../../../../instructions", import.meta.url));

test("a later layer replaces an earlier mode or checklist of the same name; others survive", () => {
  const overlays = mergeWorkbenchInstructionLayers([
    `<mode name="Review" icon="flag" proofs="review" deny="shell" />\n<mode name="Brief" proofs="plan" />\n${checklist("Base")}`,
    `<mode name="review" icon="flag" />\n${checklist("Project")}`,
  ].map(readWorkbenchInstructionLayer));
  assert.deepEqual(overlays.modes.map(mode => [mode.name, mode.proofs, mode.deny]), [["Brief", ["plan"], []], ["review", [], []]]);
  assert.deepEqual(overlays.checklists.map(entry => entry.items[0]?.label), ["Project"]);
});

test("bundled default and subagent workflows declare the full loop, gated on checklists their prompt declares", () => {
  const files = createInstructionFileGeneration({ rootPath: instructionRoot, scopeLabel: "repository instructions" });
  const base = readWorkbenchInstructionLayer(files.render("AGENTS.md"));
  const workflows = new Map(files.list("wb/workflows").map(workflow => [workflow.key, workflow]));
  for (const key of ["default", "subagent"]) {
    const workflow = workflows.get(key);
    assert.ok(workflow, key);
    const { checklists, modes } = mergeWorkbenchInstructionLayers([base, readWorkbenchInstructionLayer(files.render(workflow.relativePath))]);
    assert.deepEqual(modes.map(mode => mode.name), ["Inspect", "Brief", "Implement", "Review"], key);
    const declared = new Set(checklists.map(entry => entry.id));
    assert.deepEqual(modes.flatMap(mode => mode.proofs.filter(family => !declared.has(family))), [], key);
    const implement = modes.find(mode => mode.name === "Implement");
    assert.equal(implement?.after, key === "subagent" ? "parent-message" : "message", `${key} Implement waits for a brief to its approver`);
  }
});
