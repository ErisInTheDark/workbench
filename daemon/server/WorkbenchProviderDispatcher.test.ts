/*
 * No production exports. Tests protect provider handles across real graph replacement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "../../shared/reload/ReloadableNode";
import ReloadableNodeHost from "../../shared/reload/ReloadableNodeHost";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import WorkbenchProviderHandle from "./WorkbenchProviderHandle";
import type WorkbenchProvider from "./WorkbenchProvider";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchToolTranscriptReference } from "workbench-shared/workbench/provider/provider-execution";
import WorkbenchThreadAutoCompactController from "./WorkbenchThreadAutoCompactController";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";

test("user and agent messages on every provider share compact-before-start admission and steer safely after overlap", async () => {
  for (const harness of ["codex", "claude", "opencode"] as const) {
    for (const firstRoute of ["user", "agent"] as const) {
      const compacting = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const calls: string[] = [];
      const waits: string[] = [];
      let active = false;
      const provider = { threads: {
        read: async () => ({ status: active ? "active" : "idle" }),
        latestTurn: async () => ({ id: "previous", status: "completed" }),
        isTurnLive: async () => active,
        compact: async () => { calls.push("compact"); compacting.resolve(); await completed.promise; },
        submit: async () => {
          calls.push("user");
          const wasActive = active;
          active = true;
          return wasActive ? { kind: "steered", turnId: "new" } : { kind: "started", turn: { id: "new" } };
        },
        messageAgent: async () => {
          calls.push("agent");
          const wasActive = active;
          active = true;
          return { kind: wasActive ? "steered" : "started", turnId: "new" };
        },
      } } as unknown as WorkbenchProvider;
      const owner = new WorkbenchThreadAutoCompactController({
        readSettings: async () => DEFAULT_THREAD_AUTO_COMPACT_SETTINGS,
        readEvidence: async () => ({ activityAt: 0, contextTokens: 200_000 }),
        now: () => 30 * 60_000,
      });
      const dispatcher = new WorkbenchProviderDispatcher(async (_registration, operation) => operation(provider),
        threadId => { waits.push(threadId); }, owner.run.bind(owner));
      const send = (route: "user" | "agent") => route === "user"
        ? dispatcher.get(harness).threads.submit({ threadId: "thread", clientMessageId: "message", input: [], intent: "continue" })
        : dispatcher.get(harness).threads.messageAgent({ threadId: "thread", cwd: "C:/repo",
          message: { message: "next", senderName: "luna", senderThreadId: "sender" } });
      const first = send(firstRoute);
      await Promise.race([compacting.promise, first.then(() => assert.fail("inactive message started before compaction"))]);
      const next = send(firstRoute === "user" ? "agent" : "user");
      assert.deepEqual(calls, ["compact"]);
      completed.resolve();
      await Promise.all([first, next]);
      assert.deepEqual(calls, ["compact", firstRoute, firstRoute === "user" ? "agent" : "user"]);
      assert.deepEqual(waits, ["thread"]);
      await owner.dispose();
    }
  }
});

test("the shared provider admission gate wakes waits only for accepted steers", async () => {
  const interrupted: string[] = [];
  let agentAdmission: "started" | "steered" | "failed" = "steered";
  let userAdmission: "started" | "steered" | "failed" = "steered";
  const provider = {
    threads: {
      submit: async () => {
        if (userAdmission === "failed") throw new Error("user admission failed");
        return userAdmission === "steered"
          ? { kind: "steered" as const, turnId: "turn" }
          : { kind: "started" as const, turn: { id: "new-turn" } as never };
      },
      messageAgent: async () => {
        if (agentAdmission === "failed") throw new Error("admission failed");
        return { kind: agentAdmission, turnId: "turn" };
      },
    },
  } as unknown as WorkbenchProvider;
  const handle = new WorkbenchProviderHandle("codex", async (_registration, operation) => operation(provider),
    threadId => { interrupted.push(threadId); });
  const userMessage = {
    threadId: "parent", clientMessageId: "user-1", input: [], intent: "continue" as const,
  };
  await handle.threads.submit(userMessage);
  assert.deepEqual(interrupted, ["parent"]);

  userAdmission = "started";
  await handle.threads.submit(userMessage);
  userAdmission = "failed";
  await assert.rejects(handle.threads.submit(userMessage), /user admission failed/u);
  assert.deepEqual(interrupted, ["parent"]);

  const message = { threadId: "parent", cwd: "C:/repo", message: {
    message: "review ready", senderName: "luna", senderThreadId: "child",
  } };
  await handle.threads.messageAgent(message);
  assert.deepEqual(interrupted, ["parent", "parent"]);

  agentAdmission = "started";
  await handle.threads.messageAgent(message);
  assert.deepEqual(interrupted, ["parent", "parent"]);

  agentAdmission = "failed";
  await assert.rejects(handle.threads.messageAgent(message), /admission failed/u);
  assert.deepEqual(interrupted, ["parent", "parent"]);
});

test("tool capture finishes through the replacement owner with the original pinned identity", async () => {
  const f = fixture();
  const unused = async (): Promise<never> => { throw new Error("unexpected tool execution"); };
  const reference = { threadId: "thread", turnId: "old-turn", itemId: "item", sourceId: "child",
    parentId: "parent", tool: "task_get", arguments: {}, startedAt: 1 } as WorkbenchToolTranscriptReference;
  const tools: NonNullable<WorkbenchProvider["tools"]> = {
    patchClaims: unused, describe: unused, caller: unused, shell: unused,
    transcript: { start: async () => reference, finish: async () => assert.fail("old owner retained") },
  };
  f.setTools(tools);
  await f.host.start();
  await f.host.reload(["server:codex/def"]);
  try {
    const capture = f.providers.get("codex").tools.transcript!;
    const pinned = await capture.start({ tool: "task_get", arguments: {}, metadata: {} }, new AbortController().signal);
    assert.equal(pinned, reference);
    let finished = false;
    f.setTools({ ...tools, transcript: {
      start: unused,
      finish: async (received, result) => {
        assert.equal(received, reference);
        assert.deepEqual(result.content, [{ type: "text", text: "late output" }]);
        finished = true;
      },
    } });
    await f.host.reload(["server:codex/def"]);
    await capture.finish(pinned!, { content: [{ type: "text", text: "late output" }] });
    assert.equal(finished, true);
  } finally { await f.host.dispose(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const unused = async (): Promise<never> => { throw new Error("This fixture exercises only model context."); };
  type Objects = {
    codexProvider: WorkbenchProvider;
    openCodeProvider: WorkbenchProvider;
    claudeProvider: WorkbenchProvider;
    providers: WorkbenchProviderDispatcher;
  };
  let generation = 0;
  let failStart = false;
  let read: WorkbenchProvider["configuration"]["modelContext"]["read"] | undefined;
  let singleFile: WorkbenchProvider["singleFile"];
  let tools: WorkbenchProvider["tools"];
  let context: WorkbenchProvider["context"];
  const disposed: number[] = [];
  const started = deferred();
  const releaseStart = deferred();
  let holdStart = false;
  const graph = () => defineReloadableNodeGraph([
    ReloadableNode.define<object, Objects, never>()({
      access: "agent", children: [], description: "Provider fixture", lifecycle: "atomic",
      provides: ["codexProvider", "openCodeProvider"], requires: [], safeAll: true,
      scope: "server:codex/def",
      create: () => {
        const current = ++generation;
        const currentRead = read;
        return {
          registrations: {
            codexProvider: {
              context,
              singleFile,
              tools,
              threads: { reconcile: unused, readLatest: unused, messageAgent: unused, history: { materialize: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused },
              configuration: { models: { read: unused }, guidance: { contains: unused }, modelContext: {
                read: currentRead ?? (async () => [{ model: String(current), defaultTokens: 1000, maximumTokens: 2000 }]),
              } },
            },
            openCodeProvider: {
              threads: { reconcile: unused, readLatest: unused, messageAgent: unused, history: { materialize: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, isTurnLive: unused, materialize: unused },
              configuration: { models: { read: unused }, guidance: { contains: unused }, modelContext: {
                read: async () => [{ model: "opencode", defaultTokens: 1000, maximumTokens: 2000 }],
              } },
            },
          },
          start: async () => {
            if (failStart) throw new Error("candidate failed");
          },
          activate: async () => {
            if (holdStart) { started.resolve(); await releaseStart.promise; }
          },
          dispose: () => { disposed.push(current); },
        };
      },
    }),
    ReloadableNode.define<object, Objects, never>()({
      access: "agent", children: [], description: "Provider consumer", lifecycle: "atomic",
      provides: ["providers"], requires: [], safeAll: true,
      scope: "server:consumer",
      create: (_context, { run }) => ({
        registrations: { providers: new WorkbenchProviderDispatcher(run, () => undefined) },
        start() {}, dispose() {},
      }),
    }),
  ]);
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, { topologyScope: "server:codex/def" });
  const providers = host.get("providers");
  return {
    host, providers, disposed, started, releaseStart,
    fail: () => { failStart = true; },
    hold: () => { holdStart = true; },
    setRead: (value: typeof read) => { read = value; },
    setSingleFile: (value: typeof singleFile) => { singleFile = value; },
    setTools: (value: typeof tools) => { tools = value; },
    setContext: (value: typeof context) => { context = value; },
  };
}

test("passive context follows replacement capabilities without falling back to turn submission", async () => {
  const f = fixture();
  await f.host.start();
  try {
    const capability = f.providers.get("codex").context;
    const input = { threadId: WorkbenchThreadIdSchema.parse("thread"), text: "event" };
    assert.equal(await capability.inject(input), "unsupported");
    let calls = 0;
    f.setContext({ inject: async received => {
      assert.deepEqual(received, input);
      calls++;
      return "admitted";
    } });
    await f.host.reload(["server:codex/def"]);
    assert.equal(await capability.inject(input), "admitted");
    f.setContext(undefined);
    await f.host.reload(["server:codex/def"]);
    assert.equal(await capability.inject(input), "unsupported");
    assert.equal(calls, 1);
  } finally { await f.host.dispose(); }
});

test("optional single-file calls reject unsupported owners and follow replacement capabilities", async () => {
  const f = fixture();
  await f.host.start();
  try {
    const capability = f.providers.get("codex").singleFile;
    await assert.rejects(capability.prepare(), /does not support single-file/);
    let prepared = 0;
    f.setSingleFile({
      async prepare() { prepared++; }, async start() { return { directory: "/scratch" }; }, async input() {}, async finish() {}, async cancel() {},
    });
    await f.host.reload(["server:codex/def"]);
    await capability.prepare();
    assert.equal(prepared, 1);
    f.setSingleFile(undefined);
    await f.host.reload(["server:codex/def"]);
    await assert.rejects(capability.prepare(), /does not support single-file/);
  } finally { await f.host.dispose(); }
});

test("admitted execution retains its provider lease and later calls use replacement capability", async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  const unused = async (): Promise<never> => { throw new Error("unexpected tool"); };
  const tools: NonNullable<WorkbenchProvider["tools"]> = {
    patchClaims: unused, describe: unused, caller: unused, shell: unused,
    execute: async () => {
      entered.resolve();
      await finish.promise;
      return { exitCode: 0, stdout: "original", stderr: "" };
    },
  };
  f.setTools(tools);
  await f.host.start();
  await f.host.reload(["server:codex/def"]);
  const request = {
    caller: { threadId: WorkbenchThreadIdSchema.parse("thread"), harness: "codex", cwd: "/project" },
    command: ["echo"], cwd: "/project", permissions: { mode: "restricted" as const, writableRoots: ["/project"], network: false },
  };
  try {
    const execute = f.providers.get("codex").tools.execute!;
    const active = execute(request, new AbortController().signal);
    await entered.promise;
    f.setTools({ ...tools, execute: undefined });
    f.hold();
    const reload = f.host.reload(["server:codex/def"]);
    await f.started.promise;
    assert.equal(f.disposed.includes(2), false);
    f.releaseStart.resolve();
    finish.resolve();
    assert.equal((await active).stdout, "original");
    await reload;
    assert.equal(f.disposed.includes(2), true);
    await assert.rejects(execute(request, new AbortController().signal), /does not support admitted execution/);
  } finally {
    finish.resolve();
    f.releaseStart.resolve();
    await f.host.dispose();
  }
});

test("saved provider handles resolve replacements and survive failed candidates", async () => {
  const f = fixture();
  await f.host.start();
  try {
    const provider = f.providers.get("codex");
    assert.equal((await provider.configuration.modelContext.read())[0].model, "1");
    await f.host.reload(["server:codex/def"]);
    assert.equal((await provider.configuration.modelContext.read())[0].model, "2");
    f.fail();
    await assert.rejects(f.host.reload(["server:codex/def"]), /candidate failed/);
    assert.equal((await provider.configuration.modelContext.read())[0].model, "2");
  } finally { await f.host.dispose(); }
});

test("calls made during replacement wait for the new definition", async () => {
  const f = fixture();
  await f.host.start();
  try {
    const provider = f.providers.get("codex");
    f.hold();
    const reload = f.host.reload(["server:codex/def"]);
    await f.started.promise;
    const reading = provider.configuration.modelContext.read();
    f.releaseStart.resolve();
    await reload;
    assert.equal((await reading)[0].model, "2");
  } finally { f.releaseStart.resolve(); await f.host.dispose(); }
});

test("an operation failure remains visible and releases its graph lease", async () => {
  const f = fixture();
  f.setRead(async () => { throw new Error("catalog failed"); });
  await f.host.start();
  try {
    await f.host.reload(["server:codex/def"]);
    await assert.rejects(f.providers.get("codex").configuration.modelContext.read(), /catalog failed/);
    f.setRead(undefined);
    await f.host.reload(["server:codex/def"]);
    assert.equal((await f.providers.get("codex").configuration.modelContext.read())[0].model, "3");
  } finally { await f.host.dispose(); }
});

test("replacement does not dispose the owner of an admitted operation", async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  f.setRead(async () => {
    entered.resolve();
    await finish.promise;
    return [{ model: "admitted", defaultTokens: 1000, maximumTokens: 2000 }];
  });
  await f.host.start();
  try {
    await f.host.reload(["server:codex/def"]);
    const provider = f.providers.get("codex");
    const reading = provider.configuration.modelContext.read();
    await entered.promise;
    f.setRead(undefined);
    f.hold();
    const reload = f.host.reload(["server:codex/def"]);
    await f.started.promise;
    assert.equal(f.disposed.includes(2), false);
    f.releaseStart.resolve();
    finish.resolve();
    assert.equal((await reading)[0].model, "admitted");
    await reload;
    assert.equal(f.disposed.includes(2), true);
    assert.equal((await provider.configuration.modelContext.read())[0].model, "3");
  } finally { finish.resolve(); f.releaseStart.resolve(); await f.host.dispose(); }
});

test("a stateful operation retains its updates and cancellation owner through replacement", async () => {
  const f = fixture();
  const entered = deferred();
  const cancelled = deferred();
  const caller = new AbortController();
  const updates: string[] = [];
  let cleaned = false;
  f.setRead(async () => {
    const onAbort = () => cancelled.resolve();
    caller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      updates.push("started");
      entered.resolve();
      await cancelled.promise;
      updates.push("cancelled");
      return [];
    } finally {
      caller.signal.removeEventListener("abort", onAbort);
      cleaned = true;
    }
  });
  await f.host.start();
  try {
    await f.host.reload(["server:codex/def"]);
    const reading = f.providers.get("codex").configuration.modelContext.read();
    await entered.promise;
    f.setRead(undefined);
    f.hold();
    const reload = f.host.reload(["server:codex/def"]);
    await f.started.promise;
    assert.equal(cleaned, false);
    caller.abort();
    assert.deepEqual(await reading, []);
    assert.equal(cleaned, true);
    assert.deepEqual(updates, ["started", "cancelled"]);
    f.releaseStart.resolve();
    await reload;
  } finally { caller.abort(); f.releaseStart.resolve(); await f.host.dispose(); }
});
