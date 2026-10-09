/*
 * No exports. Tests protect coordination qualification, channel grouping, and hard transcript boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";

import {
  findThreadSubagentCoordinationSpans,
  groupThreadSubagentCoordinationConversation,
  readThreadSubagentCoordinationClaimAction,
  readThreadSubagentCoordinationQueueCheck,
  type ThreadSubagentCoordinationRole,
} from "./thread-subagent-coordination";

const incoming: ThreadSubagentCoordinationRole = { incoming: true, itemCount: 1, outgoing: false };
const outgoing: ThreadSubagentCoordinationRole = { incoming: false, itemCount: 1, outgoing: true };
const wait: ThreadSubagentCoordinationRole = { incoming: false, itemCount: 1, outgoing: false };

function mcp(
  id: string,
  tool: string,
  argumentsValue: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"],
): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return {
    appContext: null,
    arguments: argumentsValue,
    durationMs: 1,
    error: null,
    id,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    server: "wbex",
    status: "completed",
    tool,
    type: "mcpToolCall",
  };
}

function incomingItem(id: string, senderThreadId: string): Extract<ThreadItem, { type: "userMessage" }> {
  return {
    clientId: null,
    content: [{
      text: createWorkbenchAgentMessageText({ message: id, senderName: senderThreadId, senderThreadId }),
      text_elements: [],
      type: "text",
    }],
    id,
    type: "userMessage",
  };
}

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

test("conversation channels regroup within direction runs and flush on the inverse direction", () => {
  const runs = groupThreadSubagentCoordinationConversation([
    incomingItem("from-1a", "subagent-1"),
    incomingItem("from-2", "subagent-2"),
    incomingItem("from-1b", "subagent-1"),
    incomingItem("from-1c", "subagent-1"),
    mcp("release-1", "git_arc_release", { paths: ["src/one.ts"], toSubagent: "subagent-1" }),
    mcp("to-1", "message", { message: "to one", name: "subagent-1" }),
    mcp("to-2", "message", { message: "to two", name: "subagent-2" }),
    incomingItem("from-1d", "subagent-1"),
  ], (target) => `${target.kind}:${target.value ?? ""}`);

  assert.deepEqual(runs.map((run) => ({
    ids: run.items.map((item) => item.id),
    kind: run.kind,
    target: run.kind === "outgoing" ? run.target : undefined,
  })), [
    { ids: ["from-1a", "from-1b", "from-1c"], kind: "incoming", target: undefined },
    { ids: ["from-2"], kind: "incoming", target: undefined },
    { ids: ["release-1", "to-1"], kind: "outgoing", target: { kind: "name", value: "subagent-1" } },
    { ids: ["to-2"], kind: "outgoing", target: { kind: "name", value: "subagent-2" } },
    { ids: ["from-1d"], kind: "incoming", target: undefined },
  ]);
});

test("standalone adoption is an outgoing channel paragraph", () => {
  const runs = groupThreadSubagentCoordinationConversation([
    mcp("adopt", "git_arc_adopt", { name: "mira" }),
  ], (target) => `${target.kind}:${target.value ?? ""}`);

  assert.deepEqual(runs.map((run) => ({
    ids: run.items.map((item) => item.id),
    kind: run.kind,
    target: run.kind === "outgoing" ? run.target : undefined,
  })), [
    { ids: ["adopt"], kind: "outgoing", target: { kind: "name", value: "mira" } },
  ]);
});

test("subagent creation stays visible as a boundary inside the coordination conversation", () => {
  const runs = groupThreadSubagentCoordinationConversation([
    mcp("to-luna", "message", { message: "prepare", name: "luna" }),
    mcp("create", "subagent_create", {
      message: "inspect",
      name: "mira",
      profileId: "profile",
      title: "Inspect",
      userVisibleSimpleVersion: "Asked mira to inspect.",
    }),
    mcp("to-luna-again", "message", { message: "continue", name: "luna" }),
  ], (target) => `${target.kind}:${target.value ?? ""}`);

  assert.deepEqual(runs.map((run) => ({
    ids: run.items.map((item) => item.id),
    kind: run.kind,
  })), [
    { ids: ["to-luna"], kind: "outgoing" },
    { ids: ["create"], kind: "create" },
    { ids: ["to-luna-again"], kind: "outgoing" },
  ]);
});

test("read-only queue checks are coordination boundaries without admitting queue mutations", () => {
  const check = mcp("check", "subagent_queue", { queue: "machine" });
  const cliCheck = {
    aggregatedOutput: "",
    command: "wb subagent queue machine",
    commandActions: [],
    cwd: "C:/repo",
    durationMs: 1,
    exitCode: 0,
    id: "cli-check",
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  } as const satisfies Extract<ThreadItem, { type: "commandExecution" }>;
  assert.deepEqual(readThreadSubagentCoordinationQueueCheck(check), {
    item: check,
    queue: "machine",
  });
  assert.deepEqual(readThreadSubagentCoordinationQueueCheck(cliCheck), {
    item: cliCheck,
    queue: "machine",
  });
  assert.equal(readThreadSubagentCoordinationQueueCheck(
    mcp("join", "subagent_queue", { description: "tests", queue: "machine" }),
  ), null);

  const runs = groupThreadSubagentCoordinationConversation([
    mcp("to-luna", "message", { message: "prepare", name: "luna" }),
    check,
    mcp("to-luna-again", "message", { message: "continue", name: "luna" }),
  ], (target) => `${target.kind}:${target.value ?? ""}`);
  assert.deepEqual(runs.map((run) => ({
    ids: run.items.map((item) => item.id),
    kind: run.kind,
  })), [
    { ids: ["to-luna"], kind: "outgoing" },
    { ids: ["check"], kind: "queueCheck" },
    { ids: ["to-luna-again"], kind: "outgoing" },
  ]);
});
