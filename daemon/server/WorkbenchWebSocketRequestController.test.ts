/*
 * No production exports. Tests protect routing, diagnostics, socket isolation and send failures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { conformWorkbenchTranscriptSnapshot, type WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { BridgeClient, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

import WorkbenchWebSocketRequestController, { type WorkbenchWebSocketRequestControllerOptions } from "./WorkbenchWebSocketRequestController";
import WorkbenchVoiceController from "./voice/WorkbenchVoiceController";

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
  reportDelivery?: WorkbenchWebSocketRequestControllerOptions["reportDelivery"];
  reload?: WorkbenchWebSocketRequestControllerOptions["reload"];
  stats?: WorkbenchWebSocketRequestControllerOptions["stats"];
  transcript?: WorkbenchWebSocketRequestControllerOptions["transcript"];
  materialize?: (threadId: string, turnIds: string[]) => Promise<void>;
  voice?: WorkbenchWebSocketRequestControllerOptions["voice"];
}) {
  const lines = options.lines ?? [];
  const controller = new WorkbenchWebSocketRequestController({
    voice: options.voice,
    clearTimeout: options.clock.clearTimeout,
    ...(options.daemonRequests ? { daemonRequests: options.daemonRequests } : {}),
    harnesses: {
      resolveHarness: value => {
        if (value === "codex") return value;
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
    threadActions: { materialize: options.materialize ?? (async () => { throw new Error("Unexpected materialisation"); }) },
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
    writeLine: (line) => { lines.push(line); },
  });
  return { controller, lines };
}

test("voice RPC binds events and audio admission to the initiating connection", async () => {
  let audio = 0;
  let cancelled = 0;
  const disconnected: string[] = [];
  const voice = new WorkbenchVoiceController({
    recognizer: { async prepare() {}, async dispose() {}, async send(request) { if (request.type === "audio") audio++; } },
    async resolveSettings() { return { harness: "codex", model: "luna", reasoningEffort: "none", agentPath: null, agentSource: null, serviceTier: null }; },
    instructions: async () => "voice",
    provider: () => ({ async prepare() {}, async start() {}, async input() {}, async finish() {}, async cancel() { cancelled++; } }),
  });
  const { controller } = createController({
    clock: new FakeClock(), onDisconnect: connection => disconnected.push(connection),
    voice: {
      controller: voice, agents: async () => [],
      settings: {} as NonNullable<WorkbenchWebSocketRequestControllerOptions["voice"]>["settings"],
    },
  });
  const received: { owner: string; method?: string; error?: object }[] = [];
  const client = (owner: string) => createClient((data, callback) => {
    received.push({ ...JSON.parse(String(data)), owner });
    callback?.();
  });
  const first = client("first");
  const second = client("second");
  const sessionId = "9d59d847-6d43-4616-8df7-f516abc8e19d";
  try {
    await controller.handleMessage(first, "first", frame("voice/start", 1, { params: { sessionId, text: "" } }), false);
    await controller.handleMessage(second, "second", frame("voice/audio", 2, { params: { sessionId, sequence: 0, pcm: "AAAA" } }), false);
    assert.equal(audio, 0);
    assert.equal(received.some(message => message.owner === "second" && message.error), true);
    assert.ok(received.filter(message => message.method === "voice/event").every(message => message.owner === "first"));
    await controller.disconnect(first, "first");
    assert.equal(cancelled, 1);
    assert.deepEqual(disconnected, ["first"]);
  } finally { controller.dispose(); await voice.dispose(); }
});

for (const kind of ["event", "response"] as const) {
  test(`a late ${kind} send failure settles through the current graph owner`, async () => {
    const clock = new FakeClock();
    let current!: WorkbenchWebSocketRequestController;
    const reportDelivery: NonNullable<WorkbenchWebSocketRequestControllerOptions["reportDelivery"]> = (
      delivery,
    ) => current.completeDelivery(delivery);
    const previous = createController({
      clock, reportDelivery,
      daemonRequests: {
        accepts: method => method === "project/catalog/read",
        handle: async request => ({ id: request.id ?? null, result: {} }),
      },
    }).controller;
    current = previous;
    let finish!: (error?: Error) => void;
    let sent!: () => void;
    const sendingStarted = new Promise<void>(resolve => { sent = resolve; });
    const client = createClient((data, callback) => {
      const message = JSON.parse(data);
      if (message.id === 7 || message.method === "item/agentMessage/delta") {
        finish = callback!;
        sent();
      } else callback?.();
    });
    const failure = new Error("socket write failed");
    const sending = kind === "event"
      ? previous.sendJsonToClient(client, { workbenchHarness: "codex", method: "item/agentMessage/delta", params: {} })
      : previous.handleMessage(client, "connection", frame("project/catalog/read", 7), false);
    const checked = assert.rejects(sending, (error) => error === failure);
    await sendingStarted;
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
  assert.ok(traffic.some(line => line.includes("in unknown:initialized") && line.includes(`in: ${incoming.length}B`)));
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

test("sequences provider events and consumes browser receipts without harness routing", async () => {
  const clock = new FakeClock();
  const sent: Array<Record<string, unknown>> = [];
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  });
  const { controller, lines } = createController({
    clock,
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
  assert.ok(lines.some(line => line.includes("out codex:item/agentMessage/delta")));
  assert.ok(!lines.some(line => line.includes("in wb:event-stream/ack") || line.includes("secret commentary")));
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
  const { controller, lines } = createController({ clock });
  const client = createClient((data, callback) => {
    sent.push(JSON.parse(String(data)));
    callback?.();
  });
  const conformance = {
    issues: [{ code: "invalidValue", path: ["rows", "threadItems", 2, "type"] }],
    method: "workbench/transcript/updated",
    repairedPaths: [["rows", "threadTurns"]],
  };

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/conformance/report", 1, {
    params: { ...conformance, receivedPayload: "private content" },
  }), false);
  assert.deepEqual(sent.filter((message) => typeof message === "object" && message !== null && "id" in message), [
    { id: 1, result: { reported: true } },
  ]);
  const evidence = lines.filter(line => line.startsWith("[workbench-transcript-conformance] "));
  assert.equal(evidence.length, 1);
  assert.deepEqual(JSON.parse(evidence[0]!.slice("[workbench-transcript-conformance] ".length)), conformance);
  assert.ok(lines.every(line => !line.includes("private content")));

  await controller.handleMessage(client, "connection-1", frame("workbench/transcript/conformance/report", 3, {
    params: { ...conformance, method: "thread\nsecret" },
  }), false);
  assert.equal(lines.filter(line => line.startsWith("[workbench-transcript-conformance] ")).length, 1);
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
    "workbench/daemon/reload-dirt/read",
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
  assert.deepEqual(sent.find((message) => message.method === "workbench/daemon/reload-dirt/updated"), {
    method: "workbench/daemon/reload-dirt/updated",
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
      message.method === "workbench/daemon/reload-dirt/updated"
      && (message.params as { revision?: number }).revision === 2
    )).length,
    1,
  );
  snapshot = { ...snapshot, pendingScopes: [] };
  for (const listener of listeners) listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    sent.filter((message) => (
      message.method === "workbench/daemon/reload-dirt/updated"
      && (message.params as { revision?: number }).revision === 3
    )).length,
    1,
  );

  await replacement.controller.disconnect(client, "reload-observer");
  for (const listener of listeners) listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((message) => message.method === "workbench/daemon/reload-dirt/updated").length, 3);
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
    materialize: async (threadId, turnIds) => {
      events.push("materialise");
      harnessRequests.push({ params: { threadId, turnIds } });
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
  assert.deepEqual(harnessRequests.map(({ params }) => params), [{
      threadId: "thread",
      turnIds: ["turn-2", "turn-4"],
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
    materialize: async (threadId, turnIds) => {
      events.push("materialise");
      harnessRequests.push({ params: { threadId, turnIds } });
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
  assert.deepEqual(harnessRequests.map(({ params }) => params), [{ threadId: "thread", turnIds: [] }]);
  controller.dispose();
});

test("transcript materialisation failure rejects subscription without disturbing the source", async () => {
  const clock = new FakeClock();
  const sent: Array<Record<string, unknown>> = [];
  let subscriptions = 0;
  const { controller } = createController({
    clock,
    materialize: async () => { throw new Error("historical window is missing"); },
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
    materialize: async () => { await new Promise<JsonRpcResponse>((resolve) => {
      releases.push(resolve);
    }); },
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

test("an unknown request fails only itself while WB requests remain available", async () => {
  const clock = new FakeClock();
  const replies: JsonRpcResponse[] = [];
  let closed = false;
  const client = createClient((data, callback) => {
    const message = JSON.parse(data);
    if ("id" in message) replies.push(message);
    callback?.();
  });
  client.close = () => { closed = true; };
  const { controller } = createController({
    clock,
    daemonRequests: {
      accepts: method => method === "project/catalog/read",
      handle: async request => ({ id: request.id ?? null, result: { data: [] } }),
    },
  });
  try {
    await controller.handleMessage(client, "connection-1", frame("workbench/transcript/read/fake", 1, { params: {} }), false);
    await controller.handleMessage(client, "connection-1", frame("project/catalog/read", 2), false);
    assert.equal(replies[0]?.error?.code, -32601);
    assert.deepEqual(replies[1], { id: 2, result: { data: [] } });
    assert.equal(closed, false);
  } finally {
    controller.dispose();
  }
});

test("pending WB requests retain client isolation and settle through replacement delivery receipts", async () => {
  const clock = new FakeClock();
  const gates: Array<(response: JsonRpcResponse) => void> = [];
  let admitted!: () => void;
  const bothAdmitted = new Promise<void>(resolve => { admitted = resolve; });
  const firstClient = createClient();
  const secondClient = createClient();
  const previous = createController({
    clock,
    daemonRequests: {
      accepts: method => method === "project/catalog/read",
      handle: () => new Promise(resolve => {
        gates.push(resolve);
        if (gates.length === 2) admitted();
      }),
    },
  }).controller;
  const requests = [firstClient, secondClient].map((client, index) =>
    previous.handleMessage(client, `connection-${index}`, frame("project/catalog/read", 1), false));
  const retired = requests.map(request => assert.rejects(request, /detached|disposed|retired/i));
  await bothAdmitted;
  clock.advance(2_000);
  const state = previous.detachForReload();
  assert.equal(state.pending.length, 2);
  const replacement = createController({ clock, initialState: state }).controller;
  try {
    for (const resolve of gates) resolve({ id: 1, result: {} });
    await Promise.all(retired);
    await replacement.sendJsonToClient(firstClient, { id: 1, result: {} });
    const surviving = replacement.detachForReload();
    assert.equal(surviving.pending.length, 1);
    assert.equal(surviving.pending[0]?.client, secondClient);
    await replacement.resumeAfterFailedReload();
    await replacement.sendJsonToClient(secondClient, { id: 1, error: { code: -32000, message: "request failed" } });
    assert.deepEqual(replacement.detachForReload().pending, []);
  } finally {
    previous.dispose();
    replacement.dispose();
  }
});
