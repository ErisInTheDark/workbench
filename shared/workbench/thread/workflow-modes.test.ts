/*
 * No production exports. Tests mode transitions: fresh proofs per loop, cross-turn filings, missing items, ungated modes, retired defer arguments,
 * entry sources, user and parent message preconditions, undeclared and unentered modes, the completed-status pairing, compaction recovery, and what
 * refused, legacy, parent-message and recall calls contribute to the ledger.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ProofOfWork, ProofOfWorkChecklist } from "./proof-of-work";
import {
  awaitsFirstMode, compactionRecoveryNeeds, currentProcessDocuments, effectiveWorkflowMode, evaluateThreadStateTransition, gatedProofWindows,
  readFiledProofs, readModeEntered, readWorkflowLedgerEntries, type ThreadState, type WorkflowLedgerEntry, type WorkflowMode,
} from "./workflow-modes";

const plan: ProofOfWorkChecklist = {
  id: "plan", hidden: false, items: [{ id: "plan.result", label: "Result" }, { id: "plan.verify", label: "Verify" }],
};
const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.coverage", label: "Coverage" }] };
const defined = (name: string, rest: Partial<WorkflowMode> = {}): WorkflowMode => ({
  name, icon: null, color: null, proofs: [], resetOn: [], from: [], after: null, status: null, deny: [], ...rest,
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

test("missing items block, ungated modes pass, and undeclared checklists are reported", () => {
  assert.deepEqual(enter([proof({ proofs: { "plan.result": "a" } })], { mode: "Brief" }).unresolved, [{ checklist: "plan", ids: ["plan.verify"] }]);
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

test("a mode listing its sources is entered only from them, however complete the filed proofs", () => {
  const declared = [defined("Inspect"), defined("Brief"), defined("Implement", { from: ["Brief", "Implement"] })];
  const enterImplement = (ledger: WorkflowLedgerEntry[]) => evaluateThreadStateTransition(ledger, declared, [plan], { mode: "Implement" }).needsFrom;
  assert.deepEqual(enterImplement([complete, mode("Review")]), ["Brief", "Implement"], "plan proofs filed inline do not replace Brief");
  assert.deepEqual(enterImplement([]), ["Brief", "Implement"], "no mode yet counts as the first declared");
  assert.deepEqual(enterImplement([mode("Decision")]), ["Brief", "Implement"], "an undeclared current mode counts as the first declared");
  assert.deepEqual(enterImplement([mode("brief")]), []);
  assert.deepEqual(enterImplement([mode("Implement")]), [], "re-entering for an addendum");
  assert.deepEqual(enter([mode("Review")], { mode: "Brief" }).needsFrom, [], "modes without sources are entered from anywhere");
});

test("a mode entered after a message needs one since the latest mode entry, so a silent hop through its source is refused", () => {
  const declared = [defined("Brief"), defined("Implement", { from: ["Brief"], after: "message" })];
  const enterImplement = (ledger: WorkflowLedgerEntry[]) => evaluateThreadStateTransition(ledger, declared, [], { mode: "Implement" }).needsMessage;
  const message: WorkflowLedgerEntry = { kind: "message", audience: "user" };
  assert.equal(enterImplement([mode("Brief")]), true);
  assert.equal(enterImplement([message, mode("Review"), message, mode("Brief"), complete]), true, "messages before entering Brief do not count");
  assert.equal(enterImplement([mode("Brief"), message, complete]), false);
  assert.equal(enterImplement([message]), false, "with no mode entered yet, any message counts");
  assert.equal(enterImplement([mode("Brief"), { kind: "message", audience: "parent" }]), true, "a parent brief is not a user-visible message");
  assert.equal(evaluateThreadStateTransition([mode("Brief")], declared, [], { mode: "Brief" }).needsMessage, false);
});

test("a mode entered after a parent message needs one since the latest mode entry; commentary never opens it", () => {
  const declared = [defined("Brief"), defined("Implement", { from: ["Brief"], after: "parent-message" })];
  const enterImplement = (ledger: WorkflowLedgerEntry[]) => evaluateThreadStateTransition(ledger, declared, [], { mode: "Implement" }).needsMessage;
  const brief: WorkflowLedgerEntry = { kind: "message", audience: "parent" };
  assert.equal(enterImplement([mode("Brief"), { kind: "message", audience: "user" }]), true);
  assert.equal(enterImplement([brief, mode("Brief")]), true, "a brief before entering Brief does not count");
  assert.equal(enterImplement([mode("Brief"), brief]), false);
});

test("only successful messages addressed to the parent join the ledger", () => {
  const sent = (args: object, failed = false) => readWorkflowLedgerEntries({ threadId: "thread", tool: "message_agent", args, failed });
  assert.deepEqual(sent({ parent: true, message: "plan", userVisibleSimpleVersion: "plan" }), [{ kind: "message", audience: "parent" }]);
  assert.deepEqual(sent({ parent: true, message: "plan" }, true), []);
  assert.deepEqual(sent({ name: "sibling", message: "plan" }), []);
  assert.deepEqual(sent({ threadId: "thread", message: "plan" }), []);
});

test("only declared modes can be entered, and only while the workflow declares any", () => {
  assert.equal(enter([mode("Review")], { mode: "Fixing" }).unknown, true);
  assert.equal(enter([mode("Review")], { mode: "brief" }).unknown, false);
  assert.equal(evaluateThreadStateTransition([], [], [], { mode: "Anything" }).unknown, false);
  assert.equal(enter([], { status: "blocked" }).unknown, false);
  assert.deepEqual(
    [effectiveWorkflowMode([], modes)?.name, effectiveWorkflowMode([mode("Ghost")], modes)?.name, effectiveWorkflowMode([mode("review")], modes)?.name, effectiveWorkflowMode([], [])],
    ["Brief", "Brief", "Review", null],
  );
});

test("only a workflow declaring modes awaits its first one", () => {
  assert.equal(awaitsFirstMode([complete, { kind: "message", audience: "user" }], modes), true);
  assert.equal(awaitsFirstMode([mode("Ghost")], modes), false, "an undeclared mode was still entered; it falls back instead");
  assert.equal(awaitsFirstMode([], []), false);
});

test("only successful unfiltered recalls of the thread's own history join the ledger", () => {
  const recalled = (args: object, failed = false) => readWorkflowLedgerEntries({ threadId: "own", tool: "thread_recall", args, failed });
  assert.deepEqual([recalled({}), recalled({ threadId: "own", before: "ref" })], [[{ kind: "recall" }], [{ kind: "recall" }]]);
  assert.deepEqual([recalled({ threadId: "other" }), recalled({ kinds: ["plan"] }), recalled({ turn: "one-turn" }), recalled({}, true)], [[], [], [], []]);
});

test("compaction recovery needs a recall and answered checklist after the latest compaction", () => {
  const compaction: ProofOfWorkChecklist = { id: "compaction", hidden: false, items: [{ id: "compaction.narrative", label: "Narrative" }] };
  const compacted: WorkflowLedgerEntry = { kind: "compaction" };
  const recall: WorkflowLedgerEntry = { kind: "recall" };
  const narrated = proof({ proofs: { "compaction.narrative": "request, plan" } });
  const needs = (ledger: WorkflowLedgerEntry[], catalogue = [compaction]) => compactionRecoveryNeeds(ledger, catalogue);
  assert.equal(needs([recall, narrated]), null, "never compacted");
  assert.deepEqual(needs([recall, narrated, compacted]), { recall: true, proofs: ["compaction.narrative"] }, "earlier recovery does not count");
  assert.deepEqual(needs([compacted, recall]), { recall: false, proofs: ["compaction.narrative"] });
  assert.deepEqual(needs([compacted, narrated]), { recall: true, proofs: [] });
  assert.deepEqual(needs([compacted, recall, proof({ notApplicable: ["compaction.narrative"] })])?.proofs, ["compaction.narrative"]);
  assert.equal(needs([compacted, narrated, recall]), null);
  assert.equal(needs([compacted, recall], []), null, "without a declared checklist the recall alone recovers");
  assert.deepEqual(needs([compacted, recall, narrated, compacted, recall])?.proofs, ["compaction.narrative"], "each compaction needs its own");

  const gated = (ledger: WorkflowLedgerEntry[], target: string) => evaluateThreadStateTransition(
    ledger, [defined("Inspect"), ...modes], [plan, review, compaction], { mode: target },
  ).needsRecovery;
  assert.deepEqual(gated([mode("Inspect"), compacted, complete], "Brief"), { recall: true, proofs: ["compaction.narrative"] });
  assert.equal(gated([mode("Brief"), compacted], "Inspect"), null, "modes without checklists stay enterable");
  assert.equal(gated([mode("Inspect"), compacted, recall, complete, narrated], "Brief"), null);
});

test("gated families report over the same window their modes count", () => {
  const windows = gatedProofWindows([complete, mode("Review"), proof({ notApplicable: ["plan.verify"] })], modes);
  assert.deepEqual(windows.get("plan"), [{ notApplicable: ["plan.verify"] }]);
  assert.equal(windows.has("quality"), false);
});

test("refused thread_state calls keep only their proofs; legacy calls count only on success", () => {
  const args = { proofs: { "review.coverage": "ok" }, mode: "Review", status: "completed", processDocuments: ["notes.md"] };
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "thread_state", args, failed: true }), [reviewed]);
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "thread_state", args, failed: false }), [
    reviewed, { kind: "processDocuments", paths: ["notes.md"] }, mode("Review"),
  ]);
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "mode_set", args: { mode: "Brief" }, failed: false }), [mode("Brief")]);
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "mode_set", args: { mode: "Brief" }, failed: true }), []);
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "proof_of_work", args: { proofs: {} }, failed: false }), []);
  assert.deepEqual(currentProcessDocuments([{ kind: "processDocuments", paths: ["a.md"] }, { kind: "processDocuments", paths: [] }]), []);
});

test("a Workbench tool run through mcp_call counts as itself; other servers and malformed calls count for nothing", () => {
  const args = { server: "wb", tool: "thread_state", arguments: { proofs: { "review.coverage": "ok" }, mode: "Review", processDocuments: ["notes.md"] } };
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "mcp_call", args, failed: false }), [
    reviewed, { kind: "processDocuments", paths: ["notes.md"] }, mode("Review"),
  ]);
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "mcp_call", args, failed: true }), [reviewed]);
  assert.deepEqual(readWorkflowLedgerEntries({
    threadId: "thread", tool: "mcp_call", args: { server: "wb", tool: "message_agent", arguments: { parent: true } }, failed: false,
  }), [{ kind: "message", audience: "parent" }]);
  for (const other of [{ ...args, server: "docs" }, { server: "wb" }, { server: "wb", tool: "mcp_call", arguments: args }, [], null]) {
    assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "mcp_call", args: other, failed: false }), [], JSON.stringify(other));
  }
  const item = (server: string, tool: string, itemArgs: unknown) => ({
    type: "mcpToolCall", id: "i", server, tool, arguments: itemArgs, status: "completed", result: null, error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: false,
  }) as unknown as Parameters<typeof readModeEntered>[0];
  assert.equal(readModeEntered(item("wb", "mcp_call", args)), "Review");
  assert.deepEqual(readFiledProofs(item("wb", "mcp_call", args)), { proofs: { "review.coverage": "ok" } });
  assert.equal(readModeEntered(item("docs", "mcp_call", args)), null);
});

test("recorded calls that sent alwaysEditable keep their list, mode and proofs", () => {
  const args = { proofs: { "review.coverage": "ok" }, mode: "Review", alwaysEditable: ["notes.md"] };
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "thread_state", args, failed: false }), [
    reviewed, { kind: "processDocuments", paths: ["notes.md"] }, mode("Review"),
  ]);
});

test("recorded calls that sent the retired defer bucket keep their mode and other proofs", () => {
  const args = { proofs: { "review.coverage": "ok" }, defer: ["review.other"], mode: "Review" };
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "thread_state", args, failed: false }), [reviewed, mode("Review")]);
  assert.deepEqual(readWorkflowLedgerEntries({ threadId: "thread", tool: "proof_of_work", args: { proofs: { "review.coverage": "ok" }, defer: ["review.other"] }, failed: false }), [reviewed]);
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
