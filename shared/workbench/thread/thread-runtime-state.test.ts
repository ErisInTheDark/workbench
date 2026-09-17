/*
 * No production exports. Protect active-thread detection without transcript turns.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isThreadStatusActive } from "./thread-runtime-state.ts";

test("detects structured active status with and without active flags", () => {
  assert.equal(isThreadStatusActive({ type: "active", activeFlags: [] }), true);
  assert.equal(isThreadStatusActive({ type: "active", activeFlags: ["waitingOnUserInput"] }), true);
});

test("detects flattened active status with and without active flags", () => {
  assert.equal(isThreadStatusActive("active"), true);
  assert.equal(isThreadStatusActive("active:waitingOnApproval"), true);
});

test("rejects inactive structured and flattened statuses", () => {
  assert.equal(isThreadStatusActive({ type: "idle" }), false);
  assert.equal(isThreadStatusActive({ type: "notLoaded" }), false);
  assert.equal(isThreadStatusActive({ type: "systemError" }), false);
  assert.equal(isThreadStatusActive("idle"), false);
  assert.equal(isThreadStatusActive("notLoaded"), false);
  assert.equal(isThreadStatusActive("systemError"), false);
});
