/*
 * No production exports. Tests proof validation and last-answer-wins merging.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ProofOfWorkSchema, mergeProofs, countProofs, formatProofId, proofFamilies, isNotApplicable } from "./proof-of-work";

test("proofs require named items and nonblank answers", () => {
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: {} }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { invalid: "answer" } }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { "plan.result": " " } }).success, false);
  assert.equal(ProofOfWorkSchema.safeParse({ proofs: { "plan.result": "good", "plan.other": "not applicable" } }).success, true);
});

test("later answers replace earlier answers before counts", () => {
  const proofs = mergeProofs([
    { "plan.result": "first", "plan.other": "not applicable" },
    { "plan.result": " NOT APPLICABLE ", "plan.other": "checked" },
  ]);
  assert.deepEqual(proofs, { "plan.result": " NOT APPLICABLE ", "plan.other": "checked" });
  assert.deepEqual(countProofs(proofs), { answered: 1, notApplicable: 1 });
});

test("proof display labels and not-applicable classification are consistent", () => {
  assert.equal(formatProofId("recovery.missing_requirement"), "Missing requirement");
  assert.deepEqual(proofFamilies({ "review.first": "a", "quality.second": "b", "review.third": "c" }), ["Review", "Quality"]);
  assert.equal(isNotApplicable(" NOT APPLICABLE "), true);
  assert.equal(isNotApplicable("checked"), false);
});
