/*
 * No production exports. Tests proof validation, latest-state merging, checklist reconciliation and report completion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ProofOfWorkSchema, formatProofOfWorkReport, mergeProofs, presentProofOfWork, readProofOfWorkCompletion, reconcileProofOfWork,
  type ProofOfWork, type ProofOfWorkChecklist,
} from "./proof-of-work";

const plan: ProofOfWorkChecklist = {
  id: "plan",
  hidden: false,
  items: [{ id: "plan.result", label: "Result" }, { id: "plan.failure", label: "Failure" }, { id: "plan.verify", label: "Verify" }],
};

test("submissions need valid ids in exactly one bucket", () => {
  assert.equal(ProofOfWorkSchema.safeParse({}).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: {}, defer: [] }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { invalid: "answer" } }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { "plan.result": " " } }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { "plan.result": "good" }, defer: ["plan.result"] }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ notApplicable: ["plan.failure", "plan.failure"] }).success, true);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { "plan.result": "good" }, notApplicable: ["plan.failure"], defer: ["plan.verify"] }).success, true);
});

test("a later filing replaces an earlier deferral", () => {
  const proofs = mergeProofs([
    { proofs: { "plan.result": "first" }, defer: ["plan.failure", "plan.verify"] },
    { notApplicable: ["plan.failure"] },
  ]);
  const [report] = reconcileProofOfWork(proofs, [plan]).checklists;
  assert.equal(report?.resolved, 2);
  assert.deepEqual(report?.deferred, ["plan.verify"]);
  assert.deepEqual(report?.missing, []);
});

test("display leaves out hidden checklists and labels items from their declaration", () => {
  const recovery: ProofOfWorkChecklist = { id: "recovery", hidden: true, items: [{ id: "recovery.user_said", label: "What has the user said" }] };
  const shown = presentProofOfWork(mergeProofs([{
    proofs: { "plan.result": "done", "recovery.user_said": "terse", "custom.thing": "x" },
    notApplicable: ["plan.failure"],
    defer: ["plan.verify"],
  }]), [plan, recovery]);
  assert.deepEqual(shown.families, ["Plan", "Custom"]);
  assert.deepEqual(shown.answered.map(entry => [entry.label, entry.answer]), [["Result", "done"], ["Thing", "x"]]);
  assert.deepEqual(shown.notApplicable.map(entry => entry.id), ["plan.failure"]);
  assert.deepEqual(shown.deferred.map(entry => entry.id), ["plan.verify"]);
});

test("a filing's report reads back complete only when every reported checklist is", () => {
  const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.diff", label: "Diff" }] };
  const completion = (...submissions: ProofOfWork[]) => readProofOfWorkCompletion(
    formatProofOfWorkReport(reconcileProofOfWork(mergeProofs(submissions), [plan, review]), [plan, review]),
  );
  assert.equal(completion({ proofs: { "plan.result": "a" }, notApplicable: ["plan.failure", "plan.verify", "review.diff"] }), "complete");
  assert.equal(completion({ proofs: { "plan.result": "a", "review.diff": "b" } }), "partial", "missing items");
  assert.equal(completion({ notApplicable: ["plan.result", "plan.failure"], defer: ["plan.verify"] }), "partial", "deferred items");
  assert.equal(completion({ proofs: { "custom.thing": "x" } }), "complete", "unregistered checklists have nothing left to file");
  assert.equal(readProofOfWorkCompletion("Unknown checklist ids: plan.typo. Nothing was recorded.\n"), null);
});

test("reconciliation reports missing items and unknown ids only for touched families", () => {
  const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.diff", label: "Diff" }] };
  const result = reconcileProofOfWork(mergeProofs([{ proofs: { "plan.result": "a", "plan.typo": "b", "plann.result": "c" } }]), [plan, review]);
  assert.deepEqual(result.checklists.map(report => [report.checklist.id, report.missing]), [["plan", ["plan.failure", "plan.verify"]]]);
  assert.deepEqual(result.unknownItems, ["plan.typo"]);
  assert.deepEqual(result.unknownFamilies, ["plann"]);
});
