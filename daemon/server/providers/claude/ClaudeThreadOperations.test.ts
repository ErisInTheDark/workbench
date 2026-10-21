/* Exports: none. Protect Claude admission, missing-runtime rejection, context, compaction admission, pre-history rename/delete, thread interruption, turn liveness and reload adoption identity. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, TurnReferenceSchema, WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptNotification } from "workbench-shared/workbench/provider/provider-observation";
import WorkbenchThreadIdentityController from "../../thread/WorkbenchThreadIdentityController";
import { ProviderRuntimeMissingError } from "../provider-runtimes";
import ClaudeSessionHost, { ENDED_CLAUDE_SESSION } from "./ClaudeSessionHost";
import ClaudeThreadOperations, { type ClaudeThreadOperationsOptions } from "./ClaudeThreadOperations";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
const compactionScope = {
  itemId: WorkbenchItemIdSchema.parse("00000000-0000-4000-8000-000000000004"),
  turnId,
};
const selection = { kind: "custom" as const, settings: {
  harness: "claude", model: "sonnet", agentPath: null, agentSource: null,
  reasoningEffort: null, serviceTier: null,
} };

interface Captured {
  /** Each launch's custom system prompt. */
  systemPrompts: string[];
  /** Text of every user message pushed into a live session, in order. */
  pushed: string[];
  /** Input-context collection triggers, in order. */
  collected: string[];
  mcpUrls?: string[];
  instructionNames?: Array<string | null>;
}

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).map(block => block.text ?? "").join("\n");
}

function fixture({
  failNative = false, failUsage = false, usage, contextWindowTokens, launches = [], windows = [], defaults = [],
  captured, hold, subagentName, interrupt, compactQuery, signal, compactionReports = [], missingRuntime = false,
  workbenchRoot = "C:/workbench",
}: {
  workbenchRoot?: string;
  failNative?: boolean;
  missingRuntime?: boolean;
  failUsage?: boolean;
  usage: string[];
  contextWindowTokens?: number;
  /** The window cap each native launch received. */
  launches?: (string | undefined)[];
  /** The window each live usage notification reported. */
  windows?: (number | null)[];
  /** Models whose default window was looked up. */
  defaults?: string[];
  captured?: Captured;
  /** Keeps launched turns live until it resolves. */
  hold?: Promise<void>;
  subagentName?: string;
  interrupt?: () => Promise<void>;
  compactQuery?: ClaudeThreadOperationsOptions["createQuery"];
  signal?: AbortSignal;
  compactionReports?: Array<"started" | "completed" | "failed">;
}) {
  let reads = 0;
  const profile = contextWindowTokens === undefined ? selection
    : { ...selection, settings: { ...selection.settings, contextWindowTokens } };
  const sessions = new ClaudeSessionHost({
    viewsRoot: null,
    createQuery: ({ options }) => {
      if (failNative) throw new Error("native start failed");
      launches.push(options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
      const systemPrompt = options?.systemPrompt;
      const wb = options?.mcpServers?.wb;
      if (wb && "url" in wb) captured?.mcpUrls?.push(wb.url);
      if (systemPrompt && typeof systemPrompt === "object" && "prompt" in systemPrompt) {
        captured?.systemPrompts.push(String(systemPrompt.prompt));
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant", parent_tool_use_id: null,
            message: { role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          await hold;
          yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} };
        },
        close: () => undefined,
        interrupt: interrupt ?? (async () => undefined),
      } as never;
    },
  });
  if (captured) {
    const launch = sessions.launch.bind(sessions);
    Object.assign(sessions, {
      launch: async (...args: Parameters<ClaudeSessionHost["launch"]>) => {
        const session = await launch(...args);
        const push = session.push.bind(session);
        Object.assign(session, {
          push: (message: SDKUserMessage) => {
            captured.pushed.push(messageText(message.message.content));
            push(message);
          },
        });
        return session;
      },
    });
  }
  const owner = new ClaudeThreadOperations({
    daemonOrigin: "http://127.0.0.1:1",
    workbenchRoot,
    sessions,
    createQuery: compactQuery,
    signal: signal ?? new AbortController().signal,
    resolveExecutable: () => {
      if (missingRuntime) throw new ProviderRuntimeMissingError("Claude Code", "2.1.284");
      return "fake-claude";
    },
    observe: async () => undefined,
    broadcast: (notification: WorkbenchTranscriptNotification) => {
      if (notification.method === "thread/tokenUsage/updated") windows.push(notification.params.tokenUsage.modelContextWindow);
    },
    defaultContextWindow: async (model: string) => {
      defaults.push(model);
      return 1_000_000;
    },
    buildInstructions: async input => {
      captured?.instructionNames?.push(Reflect.get(input, "subagentName") ?? null);
      return "instructions";
    },
    buildActivatedSkills: async ({ activatedSkillPaths }: { activatedSkillPaths: readonly string[] }) => (
      activatedSkillPaths.length ? activatedSkillPaths.map(path => `<skill path="${path}" />`).join("\n") : null
    ),
    collectInputContext: async (_threadId: string, trigger: string) => { captured?.collected.push(trigger); },
    state: { controller: {
      getCanonicalThreadEntry: async () => ({
        entryKind: subagentName ? "subagent" : "thread", name: subagentName,
        lifecycle: { kind: "needsAttention" }, profile,
      }),
      recordAcceptedSelection: async (applied: typeof selection) => {
        usage.push(applied.settings.model);
        if (failUsage) throw new Error("history unavailable");
      },
    } },
    transcript: {
      startTurn: async () => turnId,
      recordSteer: async () => undefined,
      settleTurn: async () => undefined,
      recordAssistant: async () => undefined,
      readContextUsage: async () => null,
      recordContextUsage: async () => undefined,
      recordTurnUsage: async () => undefined,
      recordCompactionMessage: async (_threadId: string, _turnId: string, message: { subtype: string }) => {
        if (message.subtype === "compact_boundary") compactionReports.push("completed");
      },
      reportCompaction: async (_threadId: string, _turnId: string, phase: "started" | "completed" | "failed") => {
        compactionReports.push(phase);
      },
    },
  } as never);
  Object.assign(owner, {
    identity: async () => ({
      threadId, projectId,
      bindings: [{ harness: "claude", nativeLocation: "C:/repo", nativeThreadId: "native-session" }],
    }),
    read: async () => ({ turns: reads++ === 0 ? [] : [{ id: turnId, status: "inProgress" }] }),
  });
  return owner;
}

test("history demands queue as explicit, and only an explicit reconcile re-reads the session log", async () => {
  const owner = fixture({ usage: [] });
  const demands: unknown[] = [];
  Object.assign(Reflect.get(owner, "options") as object, { reconciliation: {
    reconcile: async (input: unknown) => { demands.push(input); return { turnIds: [], exhausted: true }; },
  } });
  const signal = new AbortController().signal;
  await owner.history.materialize(threadId, turnId, signal);
  assert.deepEqual(demands, [{ threadId, target: { mode: "exact", turnId }, refresh: false, explicit: true }]);
  let recovered = 0;
  Object.assign(owner, { recoverFromSessionLog: async () => { recovered += 1; return turnId; } });
  const exact = { threadId, target: { mode: "exact" as const, turnId }, gapIds: [] };
  await owner.reconcile(exact, signal);
  assert.equal(recovered, 0, "routine windows keep Claude history sqlite-only");
  assert.deepEqual(await owner.reconcile({ ...exact, explicit: true }, signal), { turnIds: [turnId], exhausted: true });
  assert.equal(recovered, 1);
});

test("manual Claude compaction targets the shared marker when the provider boundary arrives", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reports: Array<"started" | "completed" | "failed"> = [];
  const owner = fixture({
    usage: [], compactionReports: reports,
    compactQuery: () => ({
      async *[Symbol.asyncIterator]() {
        entered.resolve();
        await release.promise;
        yield { type: "system", subtype: "compact_boundary" } as never;
      },
      close: () => undefined,
    }) as never,
  });
  Object.assign(owner, { latestTurn: async () => ({ id: turnId, status: "completed" }) });
  const work = owner.compact(threadId, { scope: compactionScope });
  try {
    await entered.promise;
    assert.deepEqual(reports, []);
  } finally {
    release.resolve();
    await work;
    assert.deepEqual(reports, ["completed"]);
    await owner.dispose();
  }
});

test("failed manual Claude compaction propagates for the shared owner to settle", async () => {
  const reports: Array<"started" | "completed" | "failed"> = [];
  const owner = fixture({
    usage: [], compactionReports: reports,
    compactQuery: () => ({
      async *[Symbol.asyncIterator]() { throw new Error("compaction query failed"); },
      close: () => undefined,
    }) as never,
  });
  Object.assign(owner, { latestTurn: async () => ({ id: turnId, status: "completed" }) });
  try {
    await assert.rejects(owner.compact(threadId, { scope: compactionScope }), /compaction query failed/);
    assert.deepEqual(reports, []);
  } finally {
    await owner.dispose();
  }
});

test("Claude compaction closes its query and rejects caller or owner cancellation even after a boundary", async () => {
  for (const cause of ["caller", "owner"] as const) {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    let closes = 0;
    const owner = fixture({
      usage: [],
      signal: cause === "owner" ? cancellation.signal : undefined,
      compactQuery: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "compact_boundary" } as never;
          entered.resolve();
          await closed.promise;
        },
        close: () => { closes++; closed.resolve(); },
      }) as never,
    });
    Object.assign(owner, { latestTurn: async () => ({ id: turnId, status: "interrupted" }) });
    const work = owner.compact(threadId, {
      scope: compactionScope,
      ...(cause === "caller" ? { signal: cancellation.signal } : {}),
    });
    const rejected = assert.rejects(work, /cancelled compact/);
    await entered.promise;
    cancellation.abort(new Error("cancelled compact"));
    // Release the fake stream even if the owner forgot cancellation, so red is deterministic.
    try { assert.ok(closes > 0); }
    finally { closed.resolve(); }
    await rejected;
    await owner.dispose();
  }
});

test("Claude records accepted model use and treats recency failure as a warning, not an unsent turn", async context => {
  context.mock.method(console, "warn", () => undefined);
  const usage: string[] = [];
  const input = { threadId, clientMessageId: "message", intent: "newTurn" as const,
    input: [{ type: "text" as const, text: "hello", text_elements: [] }] };
  const accepted = await fixture({ usage }).submit(input);
  assert.equal(accepted.kind, "started");
  assert.equal(accepted.warning, undefined);
  const warned = await fixture({ usage, failUsage: true }).submit(input);
  assert.equal(warned.kind, "started");
  assert.match(warned.warning ?? "", /history unavailable/u);
  await assert.rejects(fixture({ usage, failNative: true }).submit(input), /native start failed/u);
  assert.deepEqual(usage, ["sonnet", "sonnet"]);
});

test("a missing Claude runtime rejects the turn with the Settings pointer before launching", async () => {
  const launches: (string | undefined)[] = [];
  const owner = fixture({ usage: [], launches, missingRuntime: true });
  try {
    await assert.rejects(owner.submit({ threadId, clientMessageId: "missing", intent: "newTurn",
      input: [{ type: "text", text: "hello", text_elements: [] }] }), /Settings › Agents › Providers/u);
    assert.deepEqual(launches, []);
  } finally { await owner.dispose(); }
});

test("Claude child turns carry canonical audience into their prompt and MCP catalogue", async () => {
  for (const subagentName of [undefined, "mira"]) {
    const captured: Captured = { systemPrompts: [], pushed: [], collected: [], mcpUrls: [], instructionNames: [] };
    const owner = fixture({ usage: [], captured, subagentName });
    try {
      await owner.submit({ threadId, clientMessageId: "audience", intent: "newTurn",
        input: [{ type: "text", text: "work", text_elements: [] }] });
      assert.deepEqual(captured.instructionNames, [subagentName ?? null]);
      assert.equal(new URL(captured.mcpUrls![0]!).searchParams.get("subagent"), subagentName ? "true" : null);
    } finally { await owner.dispose(); }
  }
});

test("Claude turns at the Workbench repository root list its root-only MCP tools", async () => {
  for (const workbenchRoot of ["C:/repo", "C:/workbench"]) {
    const captured: Captured = { systemPrompts: [], pushed: [], collected: [], mcpUrls: [] };
    const owner = fixture({ usage: [], captured, workbenchRoot });
    try {
      await owner.submit({ threadId, clientMessageId: "root", intent: "newTurn",
        input: [{ type: "text", text: "work", text_elements: [] }] });
      assert.equal(new URL(captured.mcpUrls![0]!).searchParams.get("project-local"), workbenchRoot === "C:/repo" ? "true" : null);
    } finally { await owner.dispose(); }
  }
});

test("Claude launches with the configured window, or the model's default, and reports it before the turn's result", async () => {
  const input = { threadId, clientMessageId: "message", intent: "newTurn" as const,
    input: [{ type: "text" as const, text: "hello", text_elements: [] }] };
  const unconfigured = { usage: [], launches: [], windows: [], defaults: [] };
  const defaulted = fixture(unconfigured);
  await defaulted.submit(input);
  await defaulted.dispose();
  assert.deepEqual(unconfigured.defaults, ["sonnet"]);
  assert.deepEqual(unconfigured.launches, ["1000000"]);
  // The first notification follows the first model round, before Claude's result names any window.
  assert.equal(unconfigured.windows[0], 1_000_000);

  const configured = { usage: [], launches: [], windows: [], defaults: [], contextWindowTokens: 300_000 };
  const explicit = fixture(configured);
  await explicit.submit(input);
  await explicit.dispose();
  assert.deepEqual(configured.defaults, []);
  assert.deepEqual(configured.launches, ["300000"]);
  assert.equal(configured.windows[0], 300_000);
});

test("Claude delivers activated skills in the new turn's conversation content, not its per-launch system prompt", async () => {
  const captured: Captured = { systemPrompts: [], pushed: [], collected: [] };
  const owner = fixture({ usage: [], captured });
  await owner.submit({ threadId, clientMessageId: "message", intent: "newTurn",
    input: [{ type: "text", text: "hello", text_elements: [] }, { type: "skill", name: "review", path: "skills/review" }],
    context: { activatedSkillPaths: ["skills/react"] } });
  await owner.dispose();
  assert.equal(captured.systemPrompts.length, 1);
  assert.doesNotMatch(captured.systemPrompts[0]!, /wb:activated-skills|skills\/re/u);
  const skillMessages = captured.pushed.filter(text => text.includes("<wb:activated-skills>"));
  assert.equal(skillMessages.length, 1);
  assert.match(skillMessages[0]!, /skills\/react/u);
  assert.match(skillMessages[0]!, /skills\/review/u);
  assert.match(skillMessages[0]!, /hello/u);
  assert.deepEqual(captured.collected, ["start"]);
});

test("a Claude steer delivers the skills it activates and collects pending agent context", async () => {
  const captured: Captured = { systemPrompts: [], pushed: [], collected: [] };
  const release = Promise.withResolvers<void>();
  const owner = fixture({ usage: [], captured, hold: release.promise });
  await owner.submit({ threadId, clientMessageId: "message", intent: "newTurn",
    input: [{ type: "text", text: "hello", text_elements: [] }] });
  const steered = await owner.submit({ threadId, clientMessageId: "steer", intent: "steer", expectedTurnId: turnId,
    input: [{ type: "text", text: "also this", text_elements: [] }, { type: "skill", name: "review", path: "skills/review" }] });
  release.resolve();
  await (Reflect.get(owner, "live") as Map<string, { whenSettled(): Promise<void> }>).get(threadId)?.whenSettled();
  await owner.dispose();
  assert.equal(steered.kind, "steered");
  const steer = captured.pushed.find(text => text.includes("also this"));
  assert.ok(steer);
  assert.match(steer, /<wb:activated-skills>[\s\S]*skills\/review/u);
  assert.deepEqual(captured.collected, ["start", "steer"]);
});

test("a Claude turn is live only while this daemon runs it or still owns its transcript scope", async () => {
  let owned = false;
  const owner = new ClaudeThreadOperations({
    daemonOrigin: "http://127.0.0.1:1",
    sessions: new ClaudeSessionHost({ viewsRoot: null }),
    signal: new AbortController().signal,
    transcript: { ownsTurn: () => owned },
  } as never);
  // A turn whose process died with an earlier daemon: no runtime, no scope.
  assert.equal(await owner.isTurnLive(threadId, turnId), false);
  owned = true;
  assert.equal(await owner.isTurnLive(threadId, turnId), true);
  owned = false;
  (Reflect.get(owner, "live") as Map<string, { turnId: string }>).set(threadId, { turnId });
  assert.equal(await owner.isTurnLive(threadId, turnId), true);
  assert.equal(await owner.isTurnLive(threadId, WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000009")), false);
});

test("a steer held while its Claude turn ends starts a new turn instead of stranding", async () => {
  const release = Promise.withResolvers<void>();
  const owner = fixture({ usage: [], hold: release.promise });
  const transcript = Reflect.get(Reflect.get(owner, "options") as object, "transcript") as Record<string, unknown>;
  const held = Promise.withResolvers<void>();
  const recorded = Promise.withResolvers<void>();
  const steers: string[] = [];
  transcript.recordSteer = async ({ status }: { status: string }) => {
    steers.push(status);
    if (status !== "pending") return;
    recorded.resolve();
    await held.promise;
  };
  let launches = 0;
  let fresh = true;
  transcript.startTurn = async () => { launches++; fresh = false; return turnId; };
  Object.assign(owner, { read: async () => ({ turns: fresh ? [] : [{ id: turnId, status: "inProgress" }] }) });
  const text = (value: string) => [{ type: "text" as const, text: value, text_elements: [] }];
  try {
    await owner.submit({ threadId, clientMessageId: "first", intent: "newTurn", input: text("hello") });
    const first = (Reflect.get(owner, "live") as Map<string, { whenSettled(): Promise<void> }>).get(threadId)!;
    const steering = owner.submit({ threadId, clientMessageId: "late", intent: "continue", input: text("one more thing") });
    await recorded.promise;
    release.resolve();
    await first.whenSettled();
    fresh = true;
    held.resolve();
    assert.equal((await steering).kind, "started");
    assert.equal(launches, 2);
    assert.deepEqual(steers, ["pending", "dismissed"]);
  } finally {
    release.resolve();
    held.resolve();
    await owner.dispose();
  }
});

test("a Claude turn adopted across a database reload is known to the replacement generation's identities", async () => {
  const stored = {
    threadId, turnId, turnIndex: 0,
    native: {
      harness: "claude", nativeLocation: "C:/repo",
      nativeThreadId: NativeThreadIdSchema.parse("native-session"), nativeTurnId: NativeTurnIdSchema.parse(turnId),
    },
  };
  // A fresh controller is what a database reload hands the adopting generation: nothing admitted in memory yet.
  const identities = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => [],
    resolveTurnIdentity: async ({ threadId: owner, turnId: reference }: { threadId: string; turnId: string }) => (
      owner === threadId && reference === turnId ? stored : null),
  } as never);
  await identities.start();
  const owner = new ClaudeThreadOperations({
    daemonOrigin: "http://127.0.0.1:1",
    sessions: { get: () => ENDED_CLAUDE_SESSION },
    signal: new AbortController().signal,
    identities,
    transcript: { restoreTurn: () => undefined, recordSteer: async () => undefined, settleTurn: async () => undefined },
    observe: async () => undefined,
    broadcast: () => undefined,
  } as never);
  Object.assign(owner, { read: async () => ({ turns: [] }), refreshUsage: () => undefined });
  const empty = {
    cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
  };
  try {
    await owner.adopt([{
      turn: {
        scope: "previous-generation", cwd: "C:/repo", projectId, threadId, turnId, workingStatusInPrompt: false,
        launchedContextWindow: null, undelivered: [], total: empty, last: null, contextWindow: null,
      },
      transcript: {} as never,
    }]);
    assert.equal(identities.knownTurn(TurnReferenceSchema.parse(turnId)).threadId, threadId);
  } finally {
    await owner.interruptAll();
    identities.dispose();
  }
});

test("a Claude thread without native history renames and deletes without its unwritten native session", async () => {
  const titles: string[] = [];
  const observed: string[] = [];
  const owner = new ClaudeThreadOperations({
    daemonOrigin: "http://127.0.0.1:1",
    sessions: new ClaudeSessionHost({ viewsRoot: null }),
    signal: new AbortController().signal,
    transcript: { rename: async (_threadId: string, _project: unknown, title: string) => { titles.push(title); } },
    identities: { observe: async ({ title }: { title: string }) => { observed.push(title); } },
  } as never);
  Object.assign(owner, {
    identity: async () => ({
      threadId, projectId, projectRoot: "C:/repo",
      bindings: [{ harness: "claude", nativeLocation: "C:/repo", nativeThreadId: "00000000-0000-4000-8000-0000000000aa" }],
    }),
    read: async () => ({ turns: [], createdAt: 1 }),
  });
  await owner.rename(threadId, "Child task");
  assert.deepEqual(titles, ["Child task"]);
  assert.deepEqual(observed, ["Child task"]);
  await owner.delete(threadId);
});

for (const fails of [false, true]) {
  test(`thread-only Claude interruption ${fails ? "propagates native failure" : "reaches the current runtime"}`, async () => {
    const release = Promise.withResolvers<void>();
    let interrupts = 0;
    const owner = fixture({ usage: [], hold: release.promise, interrupt: async () => {
      interrupts++;
      release.resolve();
      if (fails) throw new Error("native interrupt failed");
    } });
    try {
      await owner.submit({ threadId, clientMessageId: "message", intent: "newTurn",
        input: [{ type: "text", text: "hello", text_elements: [] }] });
      if (fails) await assert.rejects(owner.interrupt(threadId), /native interrupt failed/);
      else await owner.interrupt(threadId);
      assert.equal(interrupts, 1);
    } finally {
      release.resolve();
      await (Reflect.get(owner, "live") as Map<string, { whenSettled(): Promise<void> }>).get(threadId)?.whenSettled();
      await owner.dispose();
    }
  });
}

