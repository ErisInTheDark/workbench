/*
 * No exports. Tests protect final row counting, conversation boundaries across CLI and MCP, and hidden turn-end replies.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { createWorkbenchAgentMessageOutput, createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import {
  buildRenderableBlocks, getRenderableBlockItems, getWorkedBlockRows, groupIncomingAgentMessageRuns,
  reuseRenderableBlocks, hasSameBlockTimeline, type CommandItem,
} from "./thread-render-blocks";
import { partitionWorkedRows } from "./thread-worked-run";

function command(id: string, text = "pwd"): CommandItem {
  return { id, type: "commandExecution", command: text, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: 0, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed" };
}
function mcp(
  id: string,
  tool: string,
  args: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"],
): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: args, status: "completed", result: null,
    error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}
function mcpWithOutput(
  id: string,
  tool: string,
  args: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"],
  output: string,
): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return {
    ...mcp(id, tool, args),
    result: { _meta: null, content: [{ text: output, type: "text" }], structuredContent: null },
  };
}
function user(id: string): Extract<ThreadItem, { type: "userMessage" }> {
  return { clientId: null, content: [{ text: id, text_elements: [], type: "text" }], id, type: "userMessage" };
}
function steer(id: string, status: "pending" | "sent" | "failed" | "interrupted") {
  return withWorkbenchInputState(user(id), { kind: "steer", status });
}
const rows = (items: ThreadItem[]) => buildRenderableBlocks(items).flatMap(block => getWorkedBlockRows(block));

test("native file attempts share file sequences without merging identities or crossing narrative", () => {
  const edit = (id: string): Extract<ThreadItem, { type: "dynamicToolCall" }> => ({
    id, type: "dynamicToolCall", namespace: "opencode", tool: "edit",
    arguments: { path: "same.ts" }, status: "inProgress", success: null, contentItems: null, durationMs: null,
  });
  const blocks = buildRenderableBlocks([
    edit("first"), { ...edit("placeholder"), arguments: {} }, edit("second"),
    user("boundary"), edit("hidden"), edit("third"),
  ], { dynamicToolCallIds: new Set(["hidden"]) });
  assert.deepEqual(blocks.map(block => block.kind === "item" ? block.item.id : block.items.map(item => item.id)),
    [["first", "second"], "boundary", ["third"]]);
  assert.equal(blocks[0]?.kind, "fileChangeSequence");
});

test("adjacent Claude Edit and Write calls group into one file sequence like other providers", () => {
  const claude = (id: string, tool: string): ThreadItem => ({
    id, type: "dynamicToolCall", namespace: "claude", tool, arguments: { file_path: `${id}.ts` },
    status: "completed", success: true, contentItems: null, durationMs: 1,
  });
  const emptyThought: ThreadItem = { id: "thought", type: "reasoning", summary: [], content: [""] };
  const blocks = buildRenderableBlocks([
    claude("write", "Write"), emptyThought, claude("edit", "Edit"), claude("read", "Read"), claude("later", "Edit"),
  ]);
  assert.deepEqual(blocks.map(block => [block.kind, getRenderableBlockItems(block).map(item => item.id)]), [
    ["fileChangeSequence", ["write", "edit"]], ["commandSequence", ["read"]], ["fileChangeSequence", ["later"]],
  ]);
});

test("provider-native read, search, and list calls join adjacent commands", () => {
  const native = (id: string, namespace: string, tool: string, args: Record<string, string>): ThreadItem => ({
    id, type: "dynamicToolCall", namespace, tool, arguments: args,
    status: "completed", success: true, contentItems: null, durationMs: 1,
  });
  const blocks = buildRenderableBlocks([
    command("one"),
    native("claude-read", "claude", "Read", { file_path: "src/a.ts" }),
    native("opencode-read", "opencode", "read", { path: "src/b.ts" }),
    native("mystery", "acme", "frobnicate", {}),
    command("two"),
  ]);
  assert.deepEqual(blocks.map(block => [block.kind, getRenderableBlockItems(block).map(item => item.id)]), [
    ["commandSequence", ["one", "claude-read", "opencode-read"]],
    ["item", ["mystery"]],
    ["commandSequence", ["two"]],
  ]);
  assert.deepEqual(rows([native("only", "claude", "Read", { file_path: "src/a.ts" })]).map(row => row.eligible), [true],
    "native reads collapse with worked runs like ordinary commands");
});

test("captured children compact only their exact execute wrapper without deleting its evidence", () => {
  const wrapper = (id: string): ThreadItem => ({ type: "dynamicToolCall", id, namespace: "opencode",
    tool: "execute", toolCallGroupId: id, arguments: { code: "opaque code" }, status: "failed",
    success: false, contentItems: [{ type: "inputText", text: "wrapper failure" }], durationMs: 1 });
  const child = { ...mcp("child", "task_get", {}), toolCallGroupId: "parent-a" };
  const blocks = buildRenderableBlocks([wrapper("parent-a"), wrapper("parent-b"), child]);
  const a = blocks.find(block => block.kind === "item" && block.item.id === "parent-a");
  const b = blocks.find(block => block.kind === "item" && block.item.id === "parent-b");
  assert.ok(a?.kind === "item" && "hasCapturedChildren" in a && a.hasCapturedChildren);
  assert.ok(b?.kind === "item" && !("hasCapturedChildren" in b && b.hasCapturedChildren));
  assert.deepEqual(a.item, wrapper("parent-a"));
});

test("context rollover capture removes its retired execute wrapper even when the wrapper fails", () => {
  const wrapper: ThreadItem = {
    type: "dynamicToolCall", id: "execute", namespace: "opencode",
    tool: "execute", toolCallGroupId: "execute", arguments: { code: "opaque code" }, status: "failed",
    success: false, contentItems: [{ type: "inputText", text: "interrupted" }], durationMs: 1,
  };
  const child = { ...mcp("child", "thread_compact", {}), toolCallGroupId: "execute" };
  const compaction = {
    id: "compaction", type: "contextCompaction", status: "completed",
  } as const satisfies ThreadItem;
  assert.deepEqual(
    buildRenderableBlocks([wrapper, compaction, child]).flatMap(getRenderableBlockItems).map(item => item.id),
    ["compaction"],
  );
});

test("adjacent textual steers group only while their exact state matches", () => {
  const blocks = buildRenderableBlocks([
    steer("sent-a", "sent"),
    steer("sent-b", "sent"),
    steer("pending-a", "pending"),
    steer("pending-b", "pending"),
    steer("failed", "failed"),
    steer("interrupted", "interrupted"),
  ]);

  assert.deepEqual(blocks.map((block) => (
    block.kind === "userMessageSequence"
      ? { ids: block.items.map(({ id }) => id), kind: block.kind }
      : block.kind === "item"
        ? { id: block.item.id, kind: block.kind }
        : { ids: block.items.map(({ id }) => id), kind: block.kind }
  )), [
    { ids: ["sent-a", "sent-b"], kind: "userMessageSequence" },
    { ids: ["pending-a", "pending-b"], kind: "userMessageSequence" },
    { id: "failed", kind: "item" },
    { id: "interrupted", kind: "item" },
  ]);
});

test("incoming agent messages group while adjacent and held ones sit directly above held user steers", () => {
  const sender = { message: "note", senderName: "luna", senderThreadId: "child" };
  const incoming = (id: string, status?: "pending" | "failed") => {
    const item = { ...user(id), content: [{ text: createWorkbenchAgentMessageText(sender), text_elements: [], type: "text" as const }] };
    return status ? withWorkbenchInputState(item, { kind: "steer", status }) : item;
  };
  const native: ThreadItem = { ...createWorkbenchAgentMessageOutput(sender), id: "native", type: "functionCallOutput" };
  const blocks = buildRenderableBlocks([
    incoming("a"), native, mcp("boundary", "task_get", {}), incoming("b"),
    incoming("held-pending", "pending"), steer("mine", "pending"), incoming("held-failed", "failed"), incoming("c"),
  ]);
  assert.deepEqual(blocks.map(block => [
    block.kind === "agentMessageSequence" ? `agent:${block.state}` : block.kind,
    getRenderableBlockItems(block).map(item => item.id),
  ]), [
    ["agent:delivered", ["a", "native"]],
    ["commandSequence", ["boundary"]],
    ["agent:delivered", ["b"]],
    ["agent:held", ["held-pending", "held-failed"]],
    ["item", ["mine"]],
    ["agent:delivered", ["c"]],
  ]);
  assert.deepEqual(buildRenderableBlocks([incoming("only", "pending")]).map(block => block.kind), ["agentMessageSequence"]);
});

function note(id: string, senderName: string, status?: "pending" | "failed") {
  const item = { ...user(id), content: [{
    text: createWorkbenchAgentMessageText({ message: id, senderName, senderThreadId: senderName.toLowerCase() }),
    text_elements: [], type: "text" as const,
  }] };
  return status ? withWorkbenchInputState(item, { kind: "steer", status }) : item;
}
function mcpWait(id: string, names: string[], status: "completed" | "inProgress" = "completed"): ThreadItem {
  return { ...mcp(id, "subagent_wait", { names }), status } as ThreadItem;
}
function mcpMessage(id: string, name: string, message = id): ThreadItem {
  return mcp(id, "subagent_message", { message, name });
}
function cliMessage(id: string, name: string, message = id): CommandItem {
  return command(id, `wb subagent message --name ${name} --message ${message}`);
}
const blockShape = (block: ReturnType<typeof buildRenderableBlocks>[number]) => [
  block.kind === "agentMessageSequence" ? `agent:${block.state}` : block.kind,
  getRenderableBlockItems(block).map(item => item.id),
];

test("settled MCP waits ping-ponging with delivered messages fold into one exchange naming every target once", () => {
  const blocks = buildRenderableBlocks([
    mcpWait("w1", ["Rose", "Iris"]), note("m1", "Daisy"), mcpWait("w2", ["Rose", "Iris", "Daisy"]), note("m2", "Iris"),
    mcpWait("w3", ["rose", "Iris", "Daisy"]), note("m3", "Rose"),
    user("boundary"),
    mcpWait("lone", ["Rose"]), note("lone-reply", "Rose"), mcpWait("live", ["Rose"], "inProgress"),
  ]);
  assert.deepEqual(blocks.map(blockShape), [
    ["subagentWaitExchange", ["w1", "m1", "w2", "m2", "w3", "m3"]],
    ["item", ["boundary"]],
    ["item", ["lone"]], ["agent:delivered", ["lone-reply"]], ["item", ["live"]],
  ]);
  const exchange = blocks[0]!;
  assert.ok(exchange.kind === "subagentWaitExchange");
  assert.deepEqual(exchange.targets.map(target => target.value), ["Rose", "Iris", "Daisy"]);
  assert.deepEqual(exchange.messages.map(item => item.id), ["m1", "m2", "m3"]);
  assert.deepEqual(getWorkedBlockRows(exchange).map(row => row.eligible), [false], "exchanged messages never hide in worked runs");
});

test("CLI waits fold only from blocks that are nothing but waits, and held messages never join an exchange", () => {
  const cliWait = (id: string, names: string[]) => command(id, `wb subagent wait ${names.map(name => `--name ${name}`).join(" ")}`);
  const folded = buildRenderableBlocks([cliWait("c1", ["Rose"]), note("m1", "Rose"), cliWait("c2", ["Rose", "Iris"]), note("m2", "Iris")]);
  assert.deepEqual(folded.map(blockShape), [["subagentWaitExchange", ["c1", "m1", "c2", "m2"]]]);

  const apart = buildRenderableBlocks([
    cliWait("mixed", ["Rose"]), command("pwd"), note("m1", "Rose"), cliWait("after", ["Rose"]), note("m2", "Rose"),
  ]);
  assert.deepEqual(apart.map(blockShape), [
    ["commandSequence", ["mixed", "pwd"]], ["agent:delivered", ["m1"]], ["commandSequence", ["after"]], ["agent:delivered", ["m2"]],
  ]);

  const held = buildRenderableBlocks([mcpWait("w1", ["Rose"]), note("held", "Rose", "pending"), mcpWait("w2", ["Rose"])]);
  assert.deepEqual(held.map(blockShape), [["subagentWaitExchange", ["w1", "w2"]], ["agent:held", ["held"]]]);
});

test("two-way messaging gets priority over existing wait exchanges and absorbs a final live wait", () => {
  const blocks = buildRenderableBlocks([
    mcpMessage("outgoing-fern", "Fern"),
    mcpWait("w1", ["Iris", "Rose", "Daisy", "Fern", "Poppy"]),
    note("incoming-iris", "Iris"),
    mcpWait("w2", ["Iris", "Rose", "Daisy", "Fern", "Poppy"]),
    note("incoming-rose", "Rose"),
    mcpMessage("outgoing-iris", "Iris"),
    mcpWait("live", ["Iris", "Rose"], "inProgress"),
  ]);

  assert.deepEqual(blocks.map(blockShape), [[
    "subagentCoordination",
    ["outgoing-fern", "w1", "incoming-iris", "w2", "incoming-rose", "outgoing-iris", "live"],
  ]]);
  const coordination = blocks[0]!;
  assert.ok(coordination.kind === "subagentCoordination");
  assert.deepEqual(coordination.blocks.map(blockShape), [
    ["item", ["outgoing-fern"]],
    ["subagentWaitExchange", ["w1", "incoming-iris", "w2", "incoming-rose"]],
    ["item", ["outgoing-iris"]],
    ["item", ["live"]],
  ]);
  assert.deepEqual(getWorkedBlockRows(coordination).map(row => row.eligible), [false]);
});

test("the priority fold leaves one-way and held-message runs on their existing render paths", () => {
  const oneWay = buildRenderableBlocks([
    mcpMessage("outgoing", "Iris"), mcpWait("wait", ["Iris"]), mcpMessage("outgoing-again", "Iris"),
  ]);
  assert.deepEqual(oneWay.map(blockShape), [
    ["item", ["outgoing"]], ["item", ["wait"]], ["item", ["outgoing-again"]],
  ]);

  const held = buildRenderableBlocks([
    mcpMessage("outgoing", "Iris"), note("held", "Iris", "pending"), mcpWait("wait", ["Iris"]),
  ]);
  assert.deepEqual(held.map(blockShape), [
    ["item", ["outgoing"]], ["item", ["wait"]], ["agent:held", ["held"]],
  ]);
});

test("CLI message and wait sequences qualify without reviving failed outgoing messages", () => {
  const coordinated = buildRenderableBlocks([
    cliMessage("outgoing", "Iris"),
    command("wait", "wb subagent wait --name Iris"),
    note("incoming", "Iris"),
  ]);
  assert.deepEqual(coordinated.map(blockShape), [[
    "subagentCoordination", ["outgoing", "wait", "incoming"],
  ]]);

  const failed = { ...cliMessage("failed", "Iris"), exitCode: 1, status: "failed" as const };
  assert.deepEqual(buildRenderableBlocks([failed, note("incoming", "Iris")]).map(blockShape), [
    ["commandSequence", ["failed"]], ["agent:delivered", ["incoming"]],
  ]);
  assert.deepEqual(buildRenderableBlocks([
    mcp("missing-message", "subagent_message", { name: "Iris" }),
    note("incoming", "Iris"),
  ]).map(blockShape), [
    ["item", ["missing-message"]], ["agent:delivered", ["incoming"]],
  ]);
});

test("one sender's messages in one delivery state share a bubble even when another sender interleaves", () => {
  const runs = groupIncomingAgentMessageRuns([
    note("d1", "Daisy"), note("i1", "Iris"), note("i2", "Iris"), note("d2", "Daisy"),
    note("i-held", "Iris", "failed"), note("d-held", "Daisy", "failed"), note("i-held-2", "Iris", "failed"), note("i-pending", "Iris", "pending"),
  ]);
  assert.deepEqual(runs.map(run => [run.deliveryState, run.items.map(item => item.id)]), [
    [null, ["d1", "d2"]], [null, ["i1", "i2"]], ["unsent", ["i-held", "i-held-2"]], ["unsent", ["d-held"]], ["pending", ["i-pending"]],
  ]);
  assert.deepEqual(runs[1]!.messages.map(message => message.message), ["i1", "i2"]);
});

test("ordinary messages and non-message items remain steer grouping boundaries", () => {
  const blocks = buildRenderableBlocks([
    steer("before", "sent"),
    user("initial"),
    steer("after-a", "sent"),
    command("boundary"),
    steer("after-b", "sent"),
  ]);

  assert.deepEqual(blocks.map((block) => (
    block.kind === "userMessageSequence"
      ? block.items.map(({ id }) => id)
      : block.kind === "item" ? block.item.id : block.items.map(({ id }) => id)
  )), ["before", "initial", "after-a", ["boundary"], "after-b"]);
});

test("merged commands and reasoning count once each and hidden calls count zero", () => {
  const items: ThreadItem[] = [
    command("one"), command("two"),
    { type: "reasoning", id: "reason-a", summary: ["one"], content: [] },
    { type: "reasoning", id: "reason-b", summary: ["two"], content: [] },
    mcp("hidden", "request_user_input", {}),
    command("three"), command("four"),
  ];
  assert.equal(rows(items).length, 3);
  assert.deepEqual(partitionWorkedRows(rows(items)).map(group => group.length), [3]);
});

test("standalone Git rows count separately while CLI task actions split runs", () => {
  const result = rows([
    command("one"), command("two"),
    command("git", "wb git arc scope"),
    command("title", 'wb task set --title "new title"'),
    command("status", "wb task completed"),
    command("three"),
  ]);
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(row => row.eligible), [true, true, false, false, true]);
  assert.deepEqual(partitionWorkedRows(result).map(group => group.length), [2, 1, 1, 1]);
});

test("proposal rows remain visible boundaries while other Git arc work stays collapsible", () => {
  assert.deepEqual(
    rows([command("proposal-cli", 'wb git arc propose --title "Keep this visible"')]).map(row => row.eligible),
    [false],
  );
  assert.deepEqual(
    rows([mcp("proposal-mcp", "git_arc_propose", { title: "Keep this visible" })]).map(row => row.eligible),
    [false],
  );
  assert.deepEqual(
    rows([
      command("scope-cli", "wb git arc scope"),
      mcp("status-mcp", "git_arc_status", {}),
    ]).map(row => row.eligible),
    [true, true],
  );
});

test("MCP task actions and outgoing thread messages remain boundaries", () => {
  const result = rows([
    command("before"),
    mcp("title", "task_set", { title: "new" }),
    mcp("status", "task_completed", {}),
    mcp("global-message", "message", { threadId: "review-target", message: "hello" }),
    mcp("message", "subagent_message", { name: "luna", message: "hello" }),
    command("after"),
  ]);
  assert.deepEqual(result.map(row => row.eligible), [true, false, false, false, false, true]);
});

test("already-matching task title sets stay in canonical items but leave no render block", () => {
  const rendered = buildRenderableBlocks([
    command("before"),
    { ...command("cli-noop", 'wb task set --title "same"'), aggregatedOutput: "Task title already matches\n" },
    mcpWithOutput("mcp-noop", "task_set", { title: "same" }, "Task title already matches\n"),
    command("after"),
    command("cli-change", 'wb task set --title "changed"'),
    mcpWithOutput("mcp-change", "task_set", { title: "changed" }, "Task title set: changed\n"),
  ]);

  assert.deepEqual(rendered.flatMap(getRenderableBlockItems).map(item => item.id), [
    "before", "after", "cli-change", "mcp-change",
  ]);
});

test("conversation and unclassified interaction rows break work runs", () => {
  const items: ThreadItem[] = [
    { type: "userMessage", id: "user", clientId: null, content: [{ type: "text", text: "hello", text_elements: [] }] },
    { type: "agentMessage", id: "assistant", text: "reply", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
    { type: "dynamicToolCall", id: "question", namespace: null, tool: "request_user_input", arguments: {},
      contentItems: [], durationMs: null, status: "completed", success: true },
  ];
  for (const item of items) {
    assert.deepEqual(rows([command("before"), item, command("after")]).map(row => row.eligible), [true, false, true]);
  }
});

test("consecutive non-final agent messages share one commentary block until another row intervenes", () => {
  const reply = (id: string, phase: Extract<ThreadItem, { type: "agentMessage" }>["phase"]): ThreadItem => ({
    type: "agentMessage", id, text: id, phase, memoryCitation: null, delivery: null, questions: null,
  });
  const blocks = buildRenderableBlocks([
    reply("a", "commentary"), reply("b", null), command("run"), reply("c", "commentary"), reply("final", "final_answer"),
  ]);
  assert.deepEqual(blocks.map(block => [block.kind, getRenderableBlockItems(block).map(item => item.id)]), [
    ["agentCommentarySequence", ["a", "b"]],
    ["commandSequence", ["run"]],
    ["agentCommentarySequence", ["c"]],
    ["item", ["final"]],
  ]);
});

test("native plan items are excluded from render blocks", () => {
  const plan: ThreadItem = { type: "plan", id: "native-plan", text: "unsupported" };
  assert.deepEqual(buildRenderableBlocks([plan]), []);
});

test("subagent creation and incoming native messages cannot enter worked groups", () => {
  const items: ThreadItem[] = [
    command("create-cli", 'wb subagent create --profile luna --name luna --title task --message hello'),
    command("global-message-cli", 'wb message --thread review-target --message hello'),
    command("message-cli", 'wb subagent message --name luna --message hello'),
    mcp("create-mcp", "subagent_create", { profileId: "luna", name: "luna", title: "task", message: "hello" }),
    { id: "incoming", type: "functionCallOutput", namespace: "workbench", name: "agent_message", output: "incomplete message envelope" },
  ];
  for (const item of items) {
    assert.deepEqual(rows([command("before"), item, command("after")]).map(row => row.eligible), [true, false, true]);
  }
});

test("new transcript items retain unrelated blocks but invalidate an extended group or replaced item", () => {
  const first = command("first");
  const second = user("second");
  const previous = buildRenderableBlocks([first, second]);
  const appended = reuseRenderableBlocks(previous, buildRenderableBlocks([first, second, user("third")]));
  assert.equal(appended[0], previous[0]);
  assert.equal(appended[1], previous[1]);

  const extended = reuseRenderableBlocks(previous, buildRenderableBlocks([first, command("next"), second]));
  assert.notEqual(extended[0], previous[0]);
  assert.equal(extended[1], previous[1]);

  const replaced = reuseRenderableBlocks(previous, buildRenderableBlocks([{ ...first, status: "failed" }, second]));
  assert.notEqual(replaced[0], previous[0]);
  assert.equal(replaced[1], previous[1]);
});

test("turn-end marker replies stay hidden in every message phase without hiding ordinary replies", () => {
  const reply = (id: string, text: string, phase: Extract<ThreadItem, { type: "agentMessage" }>["phase"]): ThreadItem => ({
    type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null,
  });
  for (const phase of ["final_answer", "commentary", null] as const) {
    const blocks = buildRenderableBlocks([reply("answer", "done\n<wb:end />", phase), reply("end", "\n<wb:end />\n", phase)]);
    assert.deepEqual(blocks.flatMap(getRenderableBlockItems).map(item => item.id), ["answer"]);
  }
});

test("block timing changes only when one of its own item observations changes", () => {
  const [block] = buildRenderableBlocks([command("first")]);
  assert.ok(block);
  const first = { itemId: "first", startedAt: 1, firstSeenAt: 1, lastSeenAt: 2, completedAt: 2 };
  const other = { itemId: "other", startedAt: 3, firstSeenAt: 3, lastSeenAt: 4, completedAt: 4 };
  assert.equal(hasSameBlockTimeline(block, [first], [first, other]), true);
  assert.equal(hasSameBlockTimeline(block, [first], [{ ...first, completedAt: 5 }, other]), false);
});
