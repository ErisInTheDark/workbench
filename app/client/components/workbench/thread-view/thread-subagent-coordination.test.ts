/*
 * No exports. Tests protect two-way coordination span qualification and hard transcript boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  findThreadSubagentCoordinationSpans,
  readThreadSubagentCoordinationClaimAction,
  type ThreadSubagentCoordinationRole,
} from "./thread-subagent-coordination";

const incoming: ThreadSubagentCoordinationRole = { incoming: true, itemCount: 1, outgoing: false };
const outgoing: ThreadSubagentCoordinationRole = { incoming: false, itemCount: 1, outgoing: true };
const wait: ThreadSubagentCoordinationRole = { incoming: false, itemCount: 1, outgoing: false };

test("coordination spans require three items or both message directions and absorb the whole eligible run", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([
    outgoing, wait, incoming, wait, outgoing, null,
    incoming, outgoing, null,
    wait, wait, wait,
  ]), [
    { end: 5, start: 0 },
    { end: 8, start: 6 },
    { end: 12, start: 9 },
  ]);
});

test("short one-way coordination runs retain their existing rendering", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([outgoing, wait]), []);
  assert.deepEqual(findThreadSubagentCoordinationSpans([incoming, wait]), []);
  assert.deepEqual(findThreadSubagentCoordinationSpans([wait, wait]), []);
});

test("coordination qualification counts transcript items inside pre-folded render blocks", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([
    { incoming: true, itemCount: 3, outgoing: false },
  ]), [{ end: 1, start: 0 }]);
});

test("an unrelated row splits otherwise qualifying coordination", () => {
  assert.deepEqual(findThreadSubagentCoordinationSpans([
    outgoing, wait, null, incoming, wait,
  ]), []);
});

test("subagent claim transfers expose their participant and paths for coordination", () => {
  const release = readThreadSubagentCoordinationClaimAction({
    appContext: null,
    arguments: { paths: ["src/one.ts", "src/two.ts"], toSubagent: "mira" },
    durationMs: 1,
    error: null,
    id: "release",
    pluginId: null,
    readOnlyHint: null,
    result: null,
    server: "wbex",
    status: "completed",
    tool: "git_arc_release",
    type: "mcpToolCall",
  });
  const adopt = readThreadSubagentCoordinationClaimAction({
    appContext: null,
    arguments: { paths: ["src/three.ts"], threadId: "child-thread" },
    durationMs: 1,
    error: null,
    id: "adopt",
    pluginId: null,
    readOnlyHint: null,
    result: null,
    server: "wbex",
    status: "completed",
    tool: "git_arc_adopt",
    type: "mcpToolCall",
  });

  assert.deepEqual(release, {
    action: "release",
    paths: ["src/one.ts", "src/two.ts"],
    target: { kind: "name", value: "mira" },
  });
  assert.deepEqual(adopt, {
    action: "adopt",
    paths: ["src/three.ts"],
    target: { kind: "id", value: "child-thread" },
  });
});
