/*
 * Exports: none. Protect active, baseline and guard ownership algebra independently from Git storage mechanics.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { projectGitArcClaimOwnership } from "./GitArcClaimOwnershipController";

test("legacy guards project active ownership outside baseline plus dirty baseline overlap", () => {
  assert.deepEqual(projectGitArcClaimOwnership({
    baselineClaims: ["sealed.ts", "shared.ts"],
    changedBaselineClaims: ["shared.ts"],
    guardClaims: ["active.ts", "sealed.ts", "shared.ts"],
  }), {
    activeClaims: ["active.ts", "shared.ts"],
    baselineClaims: ["sealed.ts", "shared.ts"],
    guardClaims: ["active.ts", "sealed.ts", "shared.ts"],
  });
});

test("explicit clean active ownership may overlap baseline and repeated paths collapse", () => {
  assert.deepEqual(projectGitArcClaimOwnership({
    baselineClaims: ["shared.ts", "shared.ts"],
    changedBaselineClaims: [],
    guardClaims: ["shared.ts"],
    storedActiveClaims: ["shared.ts", "shared.ts"],
  }).activeClaims, ["shared.ts"]);
});

test("active and baseline ownership fail closed outside guards", () => {
  assert.throws(() => projectGitArcClaimOwnership({
    baselineClaims: ["unguarded-baseline.ts"],
    changedBaselineClaims: [],
    guardClaims: ["owned.ts"],
    storedActiveClaims: ["unguarded-active.ts"],
  }), /guards do not cover: unguarded-active\.ts, unguarded-baseline\.ts/u);
});
