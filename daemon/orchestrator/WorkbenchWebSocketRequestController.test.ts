/*
 * Keywords: websocket, transcript, event logs, receipts, timing, handoff.
 * No production exports. Tests protect routing, diagnostics, socket isolation and send failures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { conformWorkbenchTranscriptSnapshot, type WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { BridgeClient, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchOrchestratorReloadController from "./WorkbenchOrchestratorReloadController";
import WorkbenchWebSocketRequestController, { type WorkbenchWebSocketRequestControllerOptions } from "./WorkbenchWebSocketRequestController";

class FakeClock {
  nowMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };

  readonly setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, dueAt: this.nowMs + Math.max(0, delayMs) });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  advance(durationMs: number) {
    const target = this.nowMs + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = next[1].dueAt;
      next[1].callback();
    }
    this.nowMs = target;
  }
}

function createClient(send: BridgeClient["send"] = (_data, callback) => callback?.()): BridgeClient {
  return {
    OPEN: 1,
    close() {},
    on() {},
    once() {},
    readyState: 1,
    send,
  };
}

function createController(options: {
  clock: FakeClock;
  daemonRequests?: WorkbenchWebSocketRequestControllerOptions["daemonRequests"];
  initialState?: WorkbenchWebSocketRequestControllerOptions["initialState"];
  lines?: string[];
  onDisconnect?: (connectionId: string) => void;
  onHarnessMessage?: (message: JsonRpcRequest, client: BridgeClient) => Promise<void> | void;
  onHarnessRequest?: (message: JsonRpcRequest) => Promise<JsonRpcResponse> | JsonRpcResponse;
  resolvePublicRequest?: WorkbenchWebSocketRequestControllerOptions["harnesses"]["resolvePublicRequest"];
  reportDelivery?: WorkbenchWebSocketRequestControllerOptions["reportDelivery"];
  reload?: WorkbenchWebSocketRequestControllerOptions["reload"];
  stats?: WorkbenchWebSocketRequestControllerOptions["stats"];
  transcript?: WorkbenchWebSocketRequestControllerOptions["transcript"];
  transcriptShadowLog?: WorkbenchWebSocketRequestControllerOptions["transcriptShadowLog"];
}) {
  const lines = options.lines ?? [];
  const controller = new WorkbenchWebSocketRequestController({
    clearTimeout: options.clock.clearTimeout,
    ...(options.daemonRequests ? { daemonRequests: options.daemonRequests } : {}),
    harnesses: {
      handleNativeBrowserMessage: async (_harness, message, client) => await options.onHarnessMessage?.(message, client),
      resolvePublicRequest: options.resolvePublicRequest ?? (async (value, request) => {
        if (value !== "codex" && value !== "copilot" && value !== "opencode") throw new Error("Unknown Workbench harness.");
        return { harness: value, request };
      }),
      request: async (_harness, message) => await options.onHarnessRequest?.(message) ?? {
        id: message.id ?? null,
        result: {},
      },
      resolveHarness: (value, resolveOptions) => {
        if ((value === undefined || value === null || value === "") && resolveOptions?.defaultToCodex) return "codex";
        if (value === "codex" || value === "copilot" || value === "opencode") return value;
        throw new Error("Unknown Workbench harness.");
      },
    },
    initialState: options.initialState,
    now: () => options.clock.nowMs,
    reportDelivery: options.reportDelivery ?? ((delivery) => controller.completeDelivery(delivery)),
    reload: options.reload ?? {
      getReloadDirtSnapshot: () => ({ dirtyScopes: [], error: null, pendingScopes: [] }),
      subscribeReloadDirt: () => () => undefined,
    },
    setTimeout: options.clock.setTimeout,
    stats: options.stats,
    threadState: {
      acceptIntent: async () => ({ accepted: true, revision: 1 }),
      disconnect: async (connectionId) => { options.onDisconnect?.(connectionId); },
      handleRequest: async () => ({ result: { accepted: true, revision: 1 } }),
    },
    transcript: options.transcript ?? {
      read: async () => { throw new Error("Unexpected transcript read."); },
      subscribe: async () => undefined,
      unsubscribe: () => undefined,
    },
    transcriptShadowLog: options.transcriptShadowLog,
    writeLine: (line) => { lines.push(line); },
  });
  return { controller, lines };
}

test("an old identity lookup cannot dispatch a new command after rollback resumes admission", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let dispatched = 0;
  const { controller } = createController({
    clock: new FakeClock(),
    resolvePublicRequest: async (_harness, request) => {
      enter();
      await held;
      return { harness: "codex", request };
    },
    onHarnessMessage: () => { dispatched++; },
  });
  try {
    const handling = controller.handleMessage(createClient(), "connection", Buffer.from(JSON.stringify({
      id: 1, method: "thread/read", params: { threadId: "thread" },
    })), false);
    const rejected = assert.rejects(handling, /retired/);
    await entered;
    controller.suspend();
    await controller.resumeAfterFailedReload();
    release();
    await rejected;
    assert.equal(dispatched, 0);
  } finally {
    release();
    controller.dispose();
  }
});

for (const kind of ["event", "response"] as const) {
  test(`a late ${kind} send failure settles through the current graph owner`, async () => {
    const clock = new FakeClock();
    let current!: WorkbenchWebSocketRequestController;
    const reportDelivery: NonNullable<WorkbenchWebSocketRequestControllerOptions["reportDelivery"]> = (
      delivery,
    ) => current.completeDelivery(delivery);
    const previous = createController({ clock, reportDelivery }).controller;
    current = previous;
    let finish!: (error?: Error) => void;
    let hold = false;
    const client = createClient((_data, callback) => {
      if (hold) finish = callback!;
      else callback?.();
    });
    if (kind === "response") {
      await previous.handleMessage(client, "connection", Buffer.from(JSON.stringify({
        id: 7, method: "thread/read", params: { threadId: "thread" }, workbenchHarness: "codex",
      })), false);
    }
    hold = true;
    const failure = new Error("socket write failed");
    const sending = previous.sendJsonToClient(client, kind === "event"
      ? { workbenchHarness: "codex", method: "item/agentMessage/delta", params: {} }
      : { id: 7, result: {} });
    const checked = assert.rejects(sending, (error) => error === failure);
    current = createController({ clock, initialState: previous.detachForReload(), reportDelivery }).controller;
    try {
      finish(failure);
      await checked;
      assert.equal(current.readEventStreamHealth().unacknowledgedEvents, 0);
      assert.deepEqual(current.detachForReload().pending, []);
    } finally {
      previous.dispose();
      current.dispose();
    }
  });
}

for (const protocolVersion of [2, 3] as const) {
test(`rollback restores transcript protocol ${protocolVersion} without reviving old publication callbacks`, async () => {
  const subscriptions = new Map<string, Parameters<WorkbenchWebSocketRequestControllerOptions["transcript"]["subscribe"]>[0]>();
  const sent: Array<{ method?: string }> = [];
  const { controller } = createController({
    clock: new FakeClock(),
    transcript: {
      read: async () => null,
      subscribe: async (subscription) => { subscriptions.set(subscription.id, subscription); },
      unsubscribe: (id) => { subscriptions.delete(id); },
    },
  });
  const client = createClient((data, callback) => { sent.push(JSON.parse(String(data))); callback?.(); });
  try {
    await controller.handleMessage(client, "connection", frame("workbench/transcript/subscribe", 1, {
      params: { threadId: "thread", turnLimit: 1, subscriptionId: "sub", protocolVersion },
    }), false);
    const previous = [...subscriptions.values()][0]!;
    controller.detachForReload();
    assert.equal(subscriptions.size, 0);
    await controller.resumeAfterFailedReload();
    assert.equal(subscriptions.size, 1);
    const restored = [...subscriptions.values()][0]!;
    const method = protocolVersion === 3 ? "workbench/transcript/streamed" : "workbench/transcript/updated";
    if (protocolVersion === 3) {
      assert.ok(previous.publishStream);
      assert.ok(restored.publishStream);
      previous.publishStream({ kind: "absent" });
    } else {
      await previous.publish(null);
    }
    assert.equal(sent.filter((entry) => entry.method === method).length, 0);
    if (protocolVersion === 3) restored.publishStream!({ kind: "absent" });
    else await restored.publish(null);
    assert.equal(sent.filter((entry) => entry.method === method).length, 1);
  } finally {
    controller.dispose();
  }
});
}

test("traffic logs cover notifications in both directions without adding event logs for query replies", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const sent: string[] = [];
  const client = createClient((data, callback) => { sent.push(String(data)); callback?.(); });
  const incoming = Buffer.from(JSON.stringify({ method: "initialized", workbenchHarness: "codex" }));
  await controller.handleMessage(client, "connection", incoming, false);
  await controller.sendJsonToClient(client, { method: "workbench/thread-state/reset", params: {} });
  await controller.sendJsonToClient(client, { id: 300, result: {} });
  const traffic = lines.filter(line => / WS (in|out) /u.test(line));
  assert.ok(traffic.some(line => line.includes("in codex:initialized") && line.includes(`in: ${incoming.length}B`)));
  const reset = sent.find(data => JSON.parse(data).method === "workbench/thread-state/reset")!;
  assert.ok(traffic.some(line => line.includes("out wb:thread-state/reset") && line.includes(`out: ${Buffer.byteLength(reset)}B`)));
  assert.ok(!traffic.some(line => line.includes("response")));
  controller.dispose();
});

test("outgoing traffic is counted only after a successful socket callback", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  let finish: ((error?: Error) => void) | undefined;
  const client = createClient((_data, callback) => { finish = callback; });
  const message = { method: "workbench/thread-state/reset", params: {} };
  const sending = controller.sendJsonToClient(client, message);
  clock.advance(3_000);
  assert.ok(!lines.some(line => line.includes("out wb:thread-state/reset")));
  finish?.();
  await sending;
  assert.equal(lines.filter(line => line.includes("out wb:thread-state/reset")).length, 1);
  const error = new Error("socket write failed");
  const failing = controller.sendJsonToClient(client, message);
  finish?.(error);
  await assert.rejects(failing, caught => caught === error);
  clock.advance(2_000);
  assert.equal(lines.filter(line => line.includes("out wb:thread-state/reset")).length, 1);
  controller.dispose();
});

test("read and subscription replies honour each client's transcript protocol", async () => {
  const parsed = conformWorkbenchTranscriptSnapshot({
    thread: {
      id: "thread", project_id: "project", project_root: "/", title: "thread", archived: 0, pinned: 0, snoozed: 0,
      transcript_content_version: 3, next_turn_index: 1, created_at: 1, updated_at: 2, activity_at: 2,
    },
    turns: [], loadedTurnIds: [], hasPreviousTurns: false,
    rows: {
      threadItems: [{ id: 1, source_id: "fco", thread_id: "thread", turn_id: "turn", item_position: 0, type: "functionCallOutput", created_at: 1, updated_at: 2 }],
      threadItemToolOutputs: [{ item_id: 1, item_type: "functionCallOutput", name: "context", namespace: null, body_kind: "text", body_text: "result", injection_accepted_at: null }],
    },
  });
  assert.ok(parsed.success);
  const publications: Array<(snapshot: WorkbenchTranscriptSnapshot) => void | Promise<void>> = [];
  const { controller } = createController({
    clock: new FakeClock(),
    transcript: {
      read: async () => parsed.data,
      subscribe: async ({ publish }) => { publications.push(publish); },
      unsubscribe: () => undefined,
    },
  });
  const sent: Array<{ id?: number; method?: string; result?: { snapshot: WorkbenchTranscriptSnapshot }; params?: { snapshot: WorkbenchTranscriptSnapshot } }> = [];
  const client = createClient((data, callback) => { sent.push(JSON.parse(String(data))); callback?.(); });
  try {
    for (const [offset, protocolVersion] of [undefined, 2].entries()) {
      const params = { threadId: "thread", turnLimit: 1, ...(protocolVersion ? { protocolVersion } : {}) };
      await controller.handleMessage(client, "connection", frame("workbench/transcript/read", offset + 1, { params }), false);
      await controller.handleMessage(client, "connection", frame("workbench/transcript/subscribe", offset + 3, { params: { ...params, subscriptionId: `sub-${offset}` } }), false);
    }
    assert.deepEqual(sent.filter(({ result }) => result?.snapshot).map(({ result }) => result!.snapshot.rows.threadItems[0]?.type), ["unknown", "functionCallOutput"]);
    for (const publish of publications) await publish(parsed.data);
    assert.deepEqual(sent.filter(({ method }) => method === "workbench/transcript/updated").map(({ params }) => params!.snapshot.rows.threadItems[0]?.type), ["unknown", "functionCallOutput"]);
  } finally {
    controller.dispose();
  }
});

test("stats import observers receive pushed progress and disconnect cleanly", async () => {
  const sent: Array<{ method?: string }> = [];
  let publish = (_progress: WorkbenchStatsImportProgress) => undefined;
  const { controller } = createController({
    clock: new FakeClock(),
    daemonRequests: {
      accepts: (method) => method === "stats/import/start",
      handle: async (request) => ({ id: request.id ?? null, result: {} }),
    },
    stats: {
      subscribeImportProgress: (listener) => {
        publish = listener;
        return () => undefined;
      },
    },
  });
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(String(data)) as { method?: string });
    callback?.();
  });
  await controller.handleMessage(client, "stats-connection", frame("stats/import/start", 1), false);
  publish({
    claims: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
    percent: 100, recentFailures: [], revision: 2, state: "complete",
    unsupportedClaimCheckpoints: 0,
    usage: { completed: 1, failed: 0, processed: 1, total: 1, unavailable: 0 },
    version: 2,
  });
  await Promise.resolve();
  assert.equal(sent.some(({ method }) => method === "workbench/stats/import/updated"), true);
  await controller.disconnect(client, "stats-connection");
  const notificationCount = sent.filter(({ method }) => method === "workbench/stats/import/updated").length;
  publish({
    claims: { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 },
    percent: 100, recentFailures: [], revision: 3, state: "complete",
    unsupportedClaimCheckpoints: 0,
    usage: { completed: 1, failed: 0, processed: 1, total: 1, unavailable: 0 },
    version: 2,
  });
  await Promise.resolve();
  assert.equal(
    sent.filter(({ method }) => method === "workbench/stats/import/updated").length,
    notificationCount,
  );
  controller.dispose();
});

test("labels daemon and compatible Workbench requests with the wb namespace", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({
    clock,
    daemonRequests: {
      accepts: (method) => method === "project/catalog/read",
      handle: async (request) => ({ id: request.id ?? null, result: { data: [], rootPath: "" } }),
    },
  });
  const client = createClient();

  await controller.handleMessage(client, "connection-1", frame("project/catalog/read", 1), false);
  await controller.handleMessage(client, "connection-1", frame("workbench/thread-state/read", 2), false);

  const requests = lines.filter(line => line.includes(" WS wb:"));
  assert.match(requests[0] ?? "", /WS wb:project\/catalog\/read .*ok/u);
  assert.match(requests[1] ?? "", /WS wb:thread-state\/read .*ok/u);
  controller.dispose();
});

function frame(method: string, id: number, extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ id, method, ...extra }));
}

function notificationFrame(method: string, params: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ method, params }));
}

test("warns every two seconds until the matching response send completes", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const requestLines = () => lines.filter(line => line.includes("codex:thread/read"));
  const client = createClient();
  await controller.handleMessage(client, "connection-1", frame("thread/read", 7, { params: { secret: "never-log-me" } }), false);

  clock.advance(1_999);
  assert.equal(requestLines().length, 0);
  clock.advance(1);
  assert.equal(requestLines().length, 1);
  assert.match(requestLines()[0] ?? "", /codex:thread\/read .*pending.* 2\.0s/u);
  clock.advance(2_000);
  assert.equal(requestLines().length, 2);

  await controller.sendJsonToClient(client, { id: 7, result: { ok: true } });
  assert.equal(requestLines().length, 3);
  assert.match(requestLines()[2] ?? "", /codex:thread\/read .*ok.*process:.*json:.*send:.*in:.*out:/u);
  assert.match(requestLines()[2] ?? "", /in 4\.0s \u001b\[2m\(process:.*out:.*\)\u001b\[0m$/u);
  assert.equal(lines.join("\n").includes("never-log-me"), false);
  clock.advance(10_000);
  assert.equal(requestLines().length, 3);
  controller.dispose();
});

test("error completions log the full multiline message in a red follow-up entry without response data", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  await controller.handleMessage(client, "connection-1", frame("thread/read", 7), false);

  const longTail = "x".repeat(1_000);
  await controller.sendJsonToClient(client, {
    error: {
      code: -32000,
      data: { secret: "never-log-response-data" },
      message: `first line\nsecond line ${longTail}`,
    },
    id: 7,
  });

  const requests = lines.filter(line => line.includes(" WS codex:thread/read"));
  assert.equal(requests.length, 2);
  assert.match(requests[0] ?? "", /codex:thread\/read .*error.*process:.*json:.*send:.*in:.*out:/u);
  assert.equal(requests[0]?.includes("first line"), false);
  assert.equal(requests[1], ` WS codex:thread/read \u001b[31mfirst line\nsecond line ${longTail}\u001b[0m`);
  assert.equal(lines.join("\n").includes("never-log-response-data"), false);
  controller.dispose();
});

test("uses longer first-warning thresholds only for initialization and compaction", async () => {
  const initializeClock = new FakeClock();
  const initialize = createController({ clock: initializeClock });
  await initialize.controller.handleMessage(createClient(), "initialize", frame("initialize", 1), false);
  initializeClock.advance(9_999);
  assert.equal(initialize.lines.filter(line => line.includes("codex:initialize")).length, 0);
  initializeClock.advance(1);
  assert.equal(initialize.lines.filter(line => line.includes("codex:initialize")).length, 1);
  initialize.controller.dispose();

  const compactClock = new FakeClock();
  const compact = createController({ clock: compactClock });
  await compact.controller.handleMessage(createClient(), "compact", frame("thread/compact/start", 2), false);
  compactClock.advance(29_999);
  assert.equal(compact.lines.filter(line => line.includes("codex:thread/compact/start")).length, 0);
  compactClock.advance(1);
  assert.equal(compact.lines.filter(line => line.includes("codex:thread/compact/start")).length, 1);
  compact.controller.dispose();
});

test("hands pending requests to one replacement warning schedule", async () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const requestLines = () => lines.filter(line => line.includes("codex:thread/read"));
  const client = createClient();
  const first = createController({ clock, lines });
  await first.controller.handleMessage(client, "connection-1", frame("thread/read", 4), false);
  clock.advance(2_000);
  assert.equal(requestLines().length, 1);

  const state = first.controller.detachForReload();
  const replacement = createController({ clock, initialState: state, lines });
  clock.advance(2_000);
  assert.equal(requestLines().length, 2);
  await replacement.controller.sendJsonToClient(client, { id: 4, result: {} });
  clock.advance(4_000);
  assert.equal(requestLines().length, 3);
  replacement.controller.dispose();
});

test("keeps identical request ids isolated by WebSocket client", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const firstClient = createClient();
  const secondClient = createClient();
  await controller.handleMessage(firstClient, "connection-1", frame("thread/read", 1), false);
  await controller.handleMessage(secondClient, "connection-2", frame("model/list", 1, { workbenchHarness: "opencode" }), false);
  await controller.sendJsonToClient(firstClient, { id: 1, result: {} });
  clock.advance(2_000);
  assert.equal(lines.filter((line) => line.includes("codex:thread/read")).length, 1);
  assert.equal(lines.filter((line) => line.includes("opencode:model/list") && line.includes("pending")).length, 1);
  controller.dispose();
});

test("sequences provider events and consumes browser receipts without harness routing", async () => {
  const clock = new FakeClock();
  const sent: Array<Record<string, unknown>> = [];
  const harnessMessages: JsonRpcRequest[] = [];
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  });
  const { controller, lines } = createController({
    clock,
    onHarnessMessage: (message) => { harnessMessages.push(message); },
  });

  await controller.sendJsonToClient(client, {
    method: "item/agentMessage/delta",
    params: { delta: "secret commentary", itemId: "item", threadId: "thread", turnId: "turn" },
    workbenchHarness: "codex",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.workbenchEventStreamSequence, 1);
  assert.equal(controller.readEventStreamHealth().unacknowledgedEvents, 1);

  await controller.handleMessage(client, "connection-1", notificationFrame("workbench/event-stream/ack", { sequence: 1 }), false);
  assert.equal(controller.readEventStreamHealth().unacknowledgedEvents, 0);
  assert.deepEqual(harnessMessages, []);
  assert.ok(lines.some(line => line.includes("out codex:item/agentMessage/delta")));
  assert.ok(!lines.some(line => line.includes("in wb:event-stream/ack") || line.includes("secret commentary")));
  controller.dispose();
});

test("disconnect and send failure terminate their request lifecycles", async () => {
  const clock = new FakeClock();
  const disconnects: string[] = [];
  const { controller, lines } = createController({ clock, onDisconnect: (connectionId) => { disconnects.push(connectionId); } });
  const requestLines = () => lines.filter(line => line.includes("codex:thread/read"));
  const disconnectedClient = createClient();
  await controller.handleMessage(disconnectedClient, "connection-1", frame("thread/read", 1), false);
  await controller.disconnect(disconnectedClient, "connection-1");
  assert.deepEqual(disconnects, ["connection-1"]);
  assert.match(requestLines()[0] ?? "", /closed/u);

  let sends = 0;
  const failedClient = createClient((_data, callback) => {
    sends += 1;
    callback?.(sends === 1 ? undefined : new Error("socket write failed"));
  });
  await controller.handleMessage(failedClient, "connection-2", frame("thread/read", 2), false);
  await assert.rejects(controller.sendJsonToClient(failedClient, { id: 2, result: {} }), /socket write failed/u);
  assert.match(requestLines()[1] ?? "", /send-error/u);
  clock.advance(10_000);
  assert.equal(requestLines().length, 2);
  controller.dispose();
});

test("transcript dispatch decodes the exact shared operation before calling the repository", async () => {
  const clock = new FakeClock();
  const reads: unknown[] = [];
  const sent: unknown[] = [];
  const { controller } = createController({
    clock,
    transcript: {
      read: async (request) => {
        reads.push(request);
        return null;
      },
      subscribe: async () => undefined,
      unsubscribe: () => undefined,
    },
  });
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(String(data)));
    callback?.();
  });

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/read", 1, {
    params: { threadId: " thread ", turnLimit: 20, futureOption: true },
  }), false);
  assert.deepEqual(reads, [{ threadId: "thread", turnLimit: 20 }]);

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/read", 2, {
    params: { threadId: "thread", turnLimit: "20" },
  }), false);
  assert.equal(reads.length, 1);
  assert.ok(sent.some((message) => typeof message === "object" && message !== null && "error" in message));
});

test("transcript diagnostics log only decoded bounded evidence and acknowledge it", async () => {
  const clock = new FakeClock();
  const sent: unknown[] = [];
  const shadowRecords: unknown[] = [];
  const { controller, lines } = createController({
    clock,
    transcriptShadowLog: {
      flush: async () => undefined,
      write: (record) => { shadowRecords.push(record); },
    },
  });
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(String(data)));
    callback?.();
  });
  const diagnostic = {
    threadId: "thread",
    scope: "item",
    mismatch: "payload",
    jsonContext: [{
      id: "item",
      index: 0,
      kind: "item",
      payloadSignature: "abc123",
      turnId: "turn",
      type: "agentMessage",
    }],
    sqliteContext: [],
  };
  const conformance = {
    issues: [{ code: "invalidValue", path: ["rows", "threadItems", 2, "type"] }],
    method: "workbench/transcript/updated",
    repairedPaths: [["rows", "threadTurns"]],
  };

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/conformance/report", 1, {
    params: conformance,
  }), false);
  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/parity/report", 2, {
    params: diagnostic,
  }), false);
  assert.deepEqual(sent.filter((message) => typeof message === "object" && message !== null && "id" in message), [
    { id: 1, result: { reported: true } },
    { id: 2, result: { reported: true } },
  ]);
  assert.deepEqual(lines.filter((line) => line.startsWith("[workbench-transcript-parity]")), []);
  assert.deepEqual(shadowRecords, [{
    event: "conformance-mismatch",
    fields: conformance,
    level: "warning",
    source: "workbench-transcript-conformance",
  }, {
    event: "parity-mismatch",
    fields: {
      jsonContext: diagnostic.jsonContext,
      mismatch: diagnostic.mismatch,
      scope: diagnostic.scope,
      sqliteContext: diagnostic.sqliteContext,
    },
    level: "warning",
    source: "workbench-transcript-parity",
    threadId: "thread",
  }]);

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/parity/report", 3, {
    params: { ...diagnostic, threadId: "thread\nsecret" },
  }), false);
  assert.equal(lines.filter((line) => line.startsWith("[workbench-transcript-parity]")).length, 0);
  assert.ok(sent.some((message) => typeof message === "object" && message !== null && "error" in message));
  controller.dispose();
});

test("orders reload dirt observation across bootstrap, handoff, and disconnect", async () => {
  const clock = new FakeClock();
  const sent: Array<Record<string, unknown>> = [];
  let snapshot = {
    dirtyScopes: [{ dependantScopes: ["server:websocket"], description: "Core", destructive: false, scope: "server:core" }],
    error: null,
    pendingScopes: [] as string[],
  };
  const listeners = new Set<() => void>();
  let subscriptions = 0;
  let unsubscriptions = 0;
  const reload: WorkbenchWebSocketRequestControllerOptions["reload"] = {
    getReloadDirtSnapshot: () => snapshot,
    subscribeReloadDirt: (listener) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => {
        unsubscriptions += 1;
        listeners.delete(listener);
      };
    },
  };
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  });
  const first = createController({ clock, reload });
  await first.controller.start();
  await first.controller.handleMessage(client, "reload-observer", frame(
    "workbench/orchestrator/reload-dirt/read",
    11,
    { params: {} },
  ), false);
  assert.deepEqual(sent.find((message) => message.id === 11), {
    id: 11,
    result: { revision: 0, snapshot },
  });

  snapshot = { ...snapshot, pendingScopes: ["server:core"] };
  for (const listener of listeners) listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.find((message) => message.method === "workbench/orchestrator/reload-dirt/updated"), {
    method: "workbench/orchestrator/reload-dirt/updated",
    params: { revision: 1, snapshot },
  });

  const state = first.controller.detachForReload();
  assert.equal(unsubscriptions, 1);
  const replacement = createController({ clock, initialState: state, reload });
  await replacement.controller.start();
  assert.equal(subscriptions, 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    sent.filter((message) => (
      message.method === "workbench/orchestrator/reload-dirt/updated"
      && (message.params as { revision?: number }).revision === 2
    )).length,
    1,
  );
  snapshot = { ...snapshot, pendingScopes: [] };
  for (const listener of listeners) listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    sent.filter((message) => (
      message.method === "workbench/orchestrator/reload-dirt/updated"
      && (message.params as { revision?: number }).revision === 3
    )).length,
    1,
  );

  await replacement.controller.disconnect(client, "reload-observer");
  for (const listener of listeners) listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((message) => message.method === "workbench/orchestrator/reload-dirt/updated").length, 3);
  replacement.controller.dispose();
});

test("controller materialises the exact transcript window before subscribing and drops it on reload", async () => {
  const clock = new FakeClock();
  const events: string[] = [];
  const harnessRequests: JsonRpcRequest[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const subscriptions: unknown[] = [];
  const unsubscriptions: string[] = [];
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(String(data)) as Record<string, unknown>);
    callback?.();
  });
  const transcript = {
    read: async () => { throw new Error("Unexpected transcript read."); },
    subscribe: async ({ id, request }: {
      id: string;
      request: { threadId: string; turnIds?: string[]; turnLimit: number };
    }) => {
      events.push("subscribe");
      subscriptions.push({ id, request });
    },
    unsubscribe: (id: string) => { unsubscriptions.push(id); },
  };
  const first = createController({
    clock,
    onHarnessRequest: (request) => {
      events.push("materialise");
      harnessRequests.push(request);
      return { id: request.id ?? null, result: { materializedTurnIds: ["turn-2", "turn-4"], threadId: "thread" } };
    },
    transcript,
  });
  await first.controller.handleMessage(client, "connection-1", frame("thread/read", 1), false);
  await first.controller.handleMessage(client, "connection-1", frame("workbench/transcript/subscribe", 2, {
    params: {
      subscriptionId: "selected-thread",
      threadId: "thread",
      turnIds: ["turn-2", "turn-4"],
      turnLimit: 4,
    },
  }), false);
  assert.equal(
    sent.filter((message) => message.method === "workbench/transcript/capabilities").length,
    1,
  );
  assert.deepEqual(subscriptions, [{
    id: "connection-1\0selected-thread",
    request: {
      threadId: "thread",
      turnIds: ["turn-2", "turn-4"],
      turnLimit: 4,
    },
  }]);
  assert.deepEqual(events, ["materialise", "subscribe"]);
  assert.deepEqual(harnessRequests.map(({ method, params }) => ({ method, params })), [{
    method: "workbench/transcript/materialize",
    params: {
      threadId: "thread",
      turnIds: ["turn-2", "turn-4"],
    },
  }]);

  const state = first.controller.detachForReload();
  assert.deepEqual(unsubscriptions, ["connection-1\0selected-thread"]);
  const replacement = createController({ clock, initialState: state, transcript });
  await replacement.controller.start();
  assert.equal(subscriptions.length, 1);
  await replacement.controller.handleMessage(client, "connection-1", frame("account/read", 3), false);
  assert.equal(
    sent.filter((message) => message.method === "workbench/transcript/capabilities").length,
    2,
  );
  replacement.controller.dispose();
});

test("controller orders an empty exact transcript window before subscribing", async () => {
  const clock = new FakeClock();
  const events: string[] = [];
  const harnessRequests: JsonRpcRequest[] = [];
  const client = createClient((_data, callback) => { callback?.(); });
  const { controller } = createController({
    clock,
    onHarnessRequest: (request) => {
      events.push("materialise");
      harnessRequests.push(request);
      return { id: request.id ?? null, result: { materializedTurnIds: [], threadId: "thread" } };
    },
    transcript: {
      read: async () => { throw new Error("Unexpected transcript read."); },
      subscribe: async () => { events.push("subscribe"); },
      unsubscribe: () => undefined,
    },
  });

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/subscribe", 1, {
    params: {
      subscriptionId: "connecting-thread",
      threadId: "thread",
      turnIds: [],
      turnLimit: 4,
    },
  }), false);

  assert.deepEqual(events, ["materialise", "subscribe"]);
  assert.deepEqual(harnessRequests.map(({ method, params }) => ({ method, params })), [{
    method: "workbench/transcript/materialize",
    params: { threadId: "thread", turnIds: [] },
  }]);
  controller.dispose();
});

test("transcript materialisation failure rejects subscription without disturbing the source", async () => {
  const clock = new FakeClock();
  const sent: Array<Record<string, unknown>> = [];
  let subscriptions = 0;
  const { controller } = createController({
    clock,
    onHarnessRequest: (request) => ({
      error: { code: -32000, message: "historical window is missing" },
      id: request.id ?? null,
    }),
    transcript: {
      read: async () => { throw new Error("Unexpected transcript read."); },
      subscribe: async () => { subscriptions += 1; },
      unsubscribe: () => undefined,
    },
  });
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(String(data)) as Record<string, unknown>);
    callback?.();
  });

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/subscribe", 2, {
    params: {
      subscriptionId: "selected-thread",
      threadId: "thread",
      turnIds: ["missing-turn"],
      turnLimit: 4,
    },
  }), false);

  assert.equal(subscriptions, 0);
  assert.equal(
    (sent.find((message) => message.id === 2)?.error as { message?: string } | undefined)?.message,
    "historical window is missing",
  );
  controller.dispose();
});

test("a superseded transcript materialisation cannot install its stale subscription", async () => {
  const clock = new FakeClock();
  const releases: Array<(response: JsonRpcResponse) => void> = [];
  const subscribedTurnIds: Array<readonly string[] | undefined> = [];
  const { controller } = createController({
    clock,
    onHarnessRequest: async () => await new Promise<JsonRpcResponse>((resolve) => {
      releases.push(resolve);
    }),
    transcript: {
      read: async () => { throw new Error("Unexpected transcript read."); },
      subscribe: async ({ request }) => { subscribedTurnIds.push(request.turnIds); },
      unsubscribe: () => undefined,
    },
  });
  const client = createClient();
  const subscribe = (id: number, turnId: string) => controller.handleMessage(
    client,
    "connection-1",
    frame("workbench/transcript/subscribe", id, {
      params: {
        subscriptionId: "selected-thread",
        threadId: "thread",
        turnIds: [turnId],
        turnLimit: 4,
      },
    }),
    false,
  );

  const stale = subscribe(1, "turn-1");
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  const current = subscribe(2, "turn-2");
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(releases.length, 2);

  releases[0]?.({ id: 1, result: {} });
  await stale;
  assert.deepEqual(subscribedTurnIds, []);

  releases[1]?.({ id: 2, result: {} });
  await current;
  assert.deepEqual(subscribedTurnIds, [["turn-2"]]);
  controller.dispose();
});

test("an unregistered transcript-like method receives no Workbench routing privilege", async () => {
  const clock = new FakeClock();
  const harnessMethods: string[] = [];
  const { controller } = createController({
    clock,
    onHarnessMessage: (message) => { harnessMethods.push(message.method); },
  });

  await controller.handleMessage(
    createClient(),
    "connection-1",
    frame("workbench/transcript/read/fake", 1, { params: {} }),
    false,
  );
  assert.deepEqual(harnessMethods, ["workbench/transcript/read/fake"]);
});
