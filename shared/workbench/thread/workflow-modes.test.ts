/*
 * No production exports. Tests mode transitions: fresh proofs per loop, cross-turn filings, deferral, ungated modes,
 * the completed-status pairing, and what refused and legacy calls contribute to the ledger.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ProofOfWork, ProofOfWorkChecklist } from "./proof-of-work";
import {
  currentAlwaysEditable, evaluateThreadStateTransition, gatedProofWindows, readFiledProofs, readModeEntered, readWorkflowLedgerEntries,
  type ThreadState, type WorkflowLedgerEntry, type WorkflowMode,
} from "./workflow-modes";

const plan: ProofOfWorkChecklist = {
  id: "plan", hidden: false, items: [{ id: "plan.result", label: "Result" }, { id: "plan.verify", label: "Verify" }],
};
const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.coverage", label: "Coverage" }] };
const defined = (name: string, rest: Partial<WorkflowMode> = {}): WorkflowMode => ({
  name, icon: null, proofs: [], resetOn: [], status: null, deny: [], ...rest,
});
const modes: WorkflowMode[] = [
  defined("Brief", { proofs: ["plan"], resetOn: ["Review"] }),
  defined("Review", { proofs: ["review"], resetOn: ["Brief"], status: "completed" }),
];

const mode = (name: string): WorkflowLedgerEntry => ({ kind: "mode", mode: name });
const proof = (filed: ProofOfWork): WorkflowLedgerEntry => ({ kind: "proof", proof: filed });
const complete = proof({ proofs: { "plan.result": "a" }, notApplicable: ["plan.verify"] });
const reviewed = proof({ proofs: { "review.coverage": "ok" } });

function enter(ledger: readonly WorkflowLedgerEntry[], call: Pick<ThreadState, "mode" | "status">) {
  return evaluateThreadStateTransition(ledger, modes, [plan, review], call);
}

test("a gated mode needs every checklist item resolved since its reset, filed in any number of calls", () => {
  assert.deepEqual(enter([mode("Inspect")], { mode: "Brief" }).unresolved, [{ checklist: "plan", ids: ["plan.result", "plan.verify"] }]);
  const pieces = [proof({ proofs: { "plan.result": "a" } }), mode("Inspect"), proof({ notApplicable: ["plan.verify"] })];
  assert.deepEqual(enter(pieces, { mode: "brief" }).unresolved, [], "pieces filed across calls and turns count, names match case-insensitively");
});

test("the previous loop's proofs do not open the next loop's gate", () => {
  const ledger = [complete, mode("Brief"), reviewed, mode("Review"), mode("Inspect")];
  assert.deepEqual(enter(ledger, { mode: "Brief" }).unresolved, [{ checklist: "plan", ids: ["plan.result", "plan.verify"] }]);
  assert.deepEqual(enter([...ledger, complete], { mode: "Brief" }).unresolved, []);
  assert.deepEqual(enter([complete, mode("Brief"), mode("Inspect")], { mode: "Brief" }).unresolved, [], "a revised brief reuses its proofs");
});

test("deferred items block, ungated modes pass, and undeclared checklists are reported", () => {
  const deferred = proof({ proofs: { "plan.result": "a" }, defer: ["plan.verify"] });
  assert.deepEqual(enter([deferred], { mode: "Brief" }).unresolved, [{ checklist: "plan", ids: ["plan.verify"] }]);
  assert.deepEqual(enter([], { mode: "Inspect" }).unresolved, []);
  const ghost = evaluateThreadStateTransition([], [defined("Brief", { proofs: ["ghost"] })], [plan], { mode: "Brief" });
  assert.deepEqual([ghost.unresolved, ghost.undeclared], [[], ["ghost"]]);
});

test("a completed-paired mode and completion require each other; blocked and unpaired workflows are free", () => {
  assert.equal(enter([reviewed], { mode: "Review" }).needsStatus, "completed");
  assert.equal(enter([reviewed], { mode: "Review", status: "completed" }).needsStatus, null);
  assert.deepEqual(enter([mode("Implement")], { status: "completed" }).needsMode, ["Review"]);
  assert.deepEqual(enter([mode("Review")], { status: "completed" }).needsMode, [], "completing again while in Review");
  assert.deepEqual(enter([mode("Implement")], { status: "blocked" }).needsMode, []);
  const unpaired = evaluateThreadStateTransition([], [defined("Brief")], [], { status: "completed" });
  assert.deepEqual(unpaired.needsMode, [], "workflows without a paired mode complete freely");
});

test("gated families report over the same window their modes count", () => {
  const windows = gatedProofWindows([complete, mode("Review"), proof({ notApplicable: ["plan.verify"] })], modes);
  assert.deepEqual(windows.get("plan"), [{ notApplicable: ["plan.verify"] }]);
  assert.equal(windows.has("quality"), false);
});

test("refused thread_state calls keep only their proofs; legacy calls count only on success", () => {
  const args = { proofs: { "review.coverage": "ok" }, mode: "Review", status: "completed", alwaysEditable: ["notes.md"] };
  assert.deepEqual(readWorkflowLedgerEntries({ tool: "thread_state", args, failed: true }), [reviewed]);
  assert.deepEqual(readWorkflowLedgerEntries({ tool: "thread_state", args, failed: false }), [
    reviewed, { kind: "editable", paths: ["notes.md"] }, mode("Review"),
  ]);
  assert.deepEqual(readWorkflowLedgerEntries({ tool: "mode_set", args: { mode: "Brief" }, failed: false }), [mode("Brief")]);
  assert.deepEqual(readWorkflowLedgerEntries({ tool: "mode_set", args: { mode: "Brief" }, failed: true }), []);
  assert.deepEqual(readWorkflowLedgerEntries({ tool: "proof_of_work", args: { proofs: {} }, failed: false }), []);
  assert.deepEqual(currentAlwaysEditable([{ kind: "editable", paths: ["a.md"] }, { kind: "editable", paths: [] }]), []);
});

test("transcript calls enter modes only when applied, but file proofs once settled", () => {
  const call = (tool: string, status: "completed" | "failed" | "inProgress", args: object, server = "wb") => ({
    type: "mcpToolCall" as const, id: "call", server, tool, status, arguments: args,
    appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
  });
  const state = { mode: "Review", proofs: { "review.coverage": "ok" } };
  assert.deepEqual(
    [readModeEntered(call("thread_state", "completed", state)), readModeEntered(call("thread_state", "failed", state)), readModeEntered(call("mode_set", "completed", { mode: "Brief" }, "other"))],
    ["Review", null, null],
  );
  assert.deepEqual(readFiledProofs(call("thread_state", "failed", state)), { proofs: { "review.coverage": "ok" } });
  assert.equal(readFiledProofs(call("thread_state", "inProgress", state)), null);
});
