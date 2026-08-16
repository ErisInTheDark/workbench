/*
 * Tests:
 * - previousTurnLoadReducer: pins idle, loading, failed, retry, success, and reset transitions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import previousTurnLoadReducer, { type PreviousTurnLoadState } from "./previous-turn-load-state";

test("previous turn load state keeps failure durable until retry or reset", () => {
  const idle: PreviousTurnLoadState = {};
  const loading = previousTurnLoadReducer(idle, { type: "start", key: "thread-a:turn-b" });
  assert.deepEqual(loading, { "thread-a:turn-b": "loading" });

  const failed = previousTurnLoadReducer(loading, { type: "fail", key: "thread-a:turn-b" });
  assert.deepEqual(failed, { "thread-a:turn-b": "failed" });

  const retrying = previousTurnLoadReducer(failed, { type: "start", key: "thread-a:turn-b" });
  assert.deepEqual(retrying, { "thread-a:turn-b": "loading" });

  const succeeded = previousTurnLoadReducer(retrying, { type: "succeed", key: "thread-a:turn-b" });
  assert.deepEqual(succeeded, {});
  assert.deepEqual(previousTurnLoadReducer(failed, { type: "reset" }), {});
});

test("previous turn load state preserves unrelated keys", () => {
  const state: PreviousTurnLoadState = {
    "thread-a:turn-b": "failed",
    "thread-c:turn-d": "loading",
  };

  assert.deepEqual(previousTurnLoadReducer(state, { type: "succeed", key: "thread-c:turn-d" }), {
    "thread-a:turn-b": "failed",
  });
});
