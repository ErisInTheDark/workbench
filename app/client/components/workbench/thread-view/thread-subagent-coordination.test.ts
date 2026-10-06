/*
 * No exports. Tests protect two-way coordination span qualification and hard transcript boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  findThreadSubagentCoordinationSpans,
  type ThreadSubagentCoordinationRole,
} from "./thread-subagent-coordination";

const incoming: ThreadSubagentCoordinationRole = { incoming: true, outgoing: false };
const outgoing: ThreadSubagentCoordinationRole = { incoming: false, outgoing: true };
const wait: ThreadSubagentCoordinationRole = { incoming: false, outgoing: false };

test("coordination spans require both message directions and absorb the whole eligible run", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([
    outgoing, wait, incoming, wait, outgoing, null,
    incoming, wait, outgoing,
  ]), [
    { end: 5, start: 0 },
    { end: 9, start: 6 },
  ]);
});

test("one-way messages and waits retain their existing rendering", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([outgoing, wait, outgoing]), []);
  assert.deepEqual(findThreadSubagentCoordinationSpans([incoming, wait, incoming]), []);
  assert.deepEqual(findThreadSubagentCoordinationSpans([wait, wait]), []);
});

test("an unrelated row splits otherwise qualifying coordination", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([
    outgoing, wait, null, incoming, wait,
  ]), []);
});
