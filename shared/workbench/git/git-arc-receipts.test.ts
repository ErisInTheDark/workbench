/*
 * Keywords: git, receipts, transcript, scope, compatibility.
 * Exports: none. Protect recovery of scope and lifecycle facts from persisted output.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatGitArcTextReceipt, parseGitArcReceipt } from "./git-arc-receipts";

const ref = "a".repeat(40);

test("compact scope counts round trip without inventing inventory", () => {
  const output = `arc plan plan\nref ${ref}\nclaimed-count 100\nplanned-count 102\nadopted-count 2\nadded 1\nnew.ts\nend arc`;
  const receipt = parseGitArcReceipt(output);
  assert.ok(receipt);
  const roundTrip = parseGitArcReceipt(formatGitArcTextReceipt(receipt));
  assert.deepEqual(roundTrip, receipt);
  assert.equal(roundTrip.fullScope, false);
  assert.deepEqual(roundTrip.claimedPaths, []);
  assert.equal(roundTrip.plannedPaths, undefined);
  assert.match(formatGitArcTextReceipt(receipt), /planned-count 102\nadopted-count 2/u);
});

test("equal inventories are encoded once without losing either scope", () => {
  for (const paths of [[], ["two.ts", "one.ts"]]) {
    const output = formatGitArcTextReceipt({
      action: "scope", claimedPaths: paths, plannedPaths: [...paths].reverse(),
      intentName: "same scope", ref, version: 1,
    });
    const parsed = parseGitArcReceipt(output);
    assert.ok(Array.isArray(parsed?.plannedPaths));
    assert.deepEqual([...(parsed?.claimedPaths ?? [])].sort(), [...paths].sort());
    assert.deepEqual([...(parsed?.plannedPaths ?? [])].sort(), [...paths].sort());
    for (const path of paths) assert.equal(output.split("\n").filter((line) => line === path).length, 1);
  }
});

test("plain scope output distinguishes planned inventory from retained live claims", () => {
  const receipt = parseGitArcReceipt([
    "arc scope plan", `ref ${ref}`, "intent revise ownership",
    "planned 2", "one.ts", "two.ts",
    "claimed 1", "one.ts",
    "adopted 0", "end arc",
  ].join("\n"));
  assert.equal(receipt?.action, "scope");
  assert.deepEqual(receipt?.plannedPaths, ["one.ts", "two.ts"]);
  assert.deepEqual(receipt?.claimedPaths, ["one.ts"]);
});

test("receipt round trips unusual paths and does not mistake values for output sections", () => {
  const receipt = {
    action: "scope" as const, claimedPaths: ["line\nbreak.ts", '"quoted.ts', "end arc"],
    intentName: "a\nref forged", ref, version: 1 as const,
  };
  const parsed = parseGitArcReceipt(formatGitArcTextReceipt(receipt));
  assert.deepEqual(parsed?.claimedPaths, receipt.claimedPaths);
  assert.equal(parsed?.intentName, receipt.intentName);
});

test("historical JSON receipts remain readable", () => {
  const receipt = { action: "add", claimedPaths: ["old.ts"], intentName: "old plan", ref, version: 1 };
  assert.deepEqual(parseGitArcReceipt(`Workbench arc receipt: ${JSON.stringify(receipt)}`), receipt);
});

test("truncated inventory does not become a successful partial receipt", () => {
  assert.equal(parseGitArcReceipt(`arc scope active\nref ${ref}\nclaimed 2\none.ts\nend arc`), null);
});
