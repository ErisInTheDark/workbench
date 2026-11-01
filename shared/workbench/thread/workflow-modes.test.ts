/*
 * No production exports. Tests mode gate windows: fresh proofs per loop, cross-turn filings, deferral and ungated modes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ProofOfWork, ProofOfWorkChecklist } from "./proof-of-work";
import { evaluateModeGate, gatedProofWindows, readModeSwitch, readWorkflowLedgerEntry, type ModeGate, type WorkflowLedgerEntry } from "./workflow-modes";

const plan: ProofOfWorkChecklist = {
  id: "plan", hidden: false, items: [{ id: "plan.result", label: "Result" }, { id: "plan.verify", label: "Verify" }],
};
const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.coverage", label: "Coverage" }] };
const gates: ModeGate[] = [
  { mode: "Brief", checklists: ["plan"], since: ["Review"] },
  { mode: "Review", checklists: ["review"], since: ["Brief"] },
];

const mode = (name: string): WorkflowLedgerEntry => ({ kind: "mode", mode: name });
const proof = (filed: ProofOfWork): WorkflowLedgerEntry => ({ kind: "proof", proof: filed });
const complete = proof({ proofs: { "plan.result": "a" }, notApplicable: ["plan.verify"] });

function enter(ledger: readonly WorkflowLedgerEntry[], target: string) {
  return evaluateModeGate(ledger, gates, [plan, review], target).unresolved;
}

test("a gated mode needs every checklist item resolved since its boundary, filed in any number of calls", () => {
  assert.deepEqual(enter([mode("Inspect")], "Brief"), [{ checklist: "plan", ids: ["plan.result", "plan.verify"] }]);
  const pieces = [proof({ proofs: { "plan.result": "a" } }), mode("Inspect"), proof({ notApplicable: ["plan.verify"] })];
  assert.deepEqual(enter(pieces, "brief"), [], "pieces filed across calls and turns count, names match case-insensitively");
});

test("the previous loop's proofs do not open the next loop's gate", () => {
  const ledger = [complete, mode("Brief"), proof({ proofs: { "review.coverage": "ok" } }), mode("Review"), mode("Inspect")];
  assert.deepEqual(enter(ledger, "Brief"), [{ checklist: "plan", ids: ["plan.result", "plan.verify"] }]);
  assert.deepEqual(enter([...ledger, complete], "Brief"), []);
  assert.deepEqual(enter([complete, mode("Brief"), mode("Decision"), mode("Brief")], "Brief"), [], "a revised brief in the same loop reuses its proofs");
});

test("deferred items block, ungated modes pass, and undeclared gate checklists are reported", () => {
  assert.deepEqual(enter([proof({ proofs: { "plan.result": "a" }, defer: ["plan.verify"] })], "Brief"), [{ checklist: "plan", ids: ["plan.verify"] }]);
  assert.deepEqual(enter([], "Decision"), []);
  const missing = evaluateModeGate([], [{ mode: "Brief", checklists: ["ghost"], since: [] }], [plan], "Brief");
  assert.deepEqual([missing.unresolved, missing.undeclared], [[], ["ghost"]]);
});

test("gated families report over the same window their gate counts", () => {
  const windows = gatedProofWindows([complete, mode("Review"), proof({ notApplicable: ["plan.verify"] })], gates);
  assert.deepEqual(windows.get("plan"), [{ notApplicable: ["plan.verify"] }]);
  assert.equal(windows.has("quality"), false);
});

test("only successful Workbench mode switches and well-formed filings enter the ledger", () => {
  const call = (status: "completed" | "failed", server = "wb") => readModeSwitch({
    type: "mcpToolCall", id: "switch", server, tool: "mode_set", status, arguments: { mode: "Brief" },
    appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
  });
  assert.deepEqual([call("completed"), call("failed"), call("completed", "other")], ["Brief", null, null]);
  assert.deepEqual(readWorkflowLedgerEntry("mode_set", { mode: "Review" }), mode("Review"));
  assert.equal(readWorkflowLedgerEntry("proof_of_work", { proofs: {} }), null);
  assert.equal(readWorkflowLedgerEntry("task_completed", {}), null);
});
