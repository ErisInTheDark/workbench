/*
 * No production exports. Tests protect provider handles across real graph replacement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "../../shared/reload/ReloadableNode";
import ReloadableNodeHost from "../../shared/reload/ReloadableNodeHost";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchProvider from "./WorkbenchProvider";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchToolTranscriptReference } from "workbench-shared/workbench/provider/provider-execution";

test("tool capture finishes through the replacement owner with the original pinned identity", async () => {
  const f = fixture();
  const unused = async (): Promise<never> => { throw new Error("unexpected tool execution"); };
  const reference = { threadId: "thread", turnId: "old-turn", itemId: "item", sourceId: "child",
    parentId: "parent", tool: "task_get", arguments: {}, startedAt: 1 } as WorkbenchToolTranscriptReference;
  const tools: NonNullable<WorkbenchProvider["tools"]> = {
    patchClaims: unused, executeReadOnly: unused, describe: unused, caller: unused, shell: unused,
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
    providers: WorkbenchProviderDispatcher;
  };
  let generation = 0;
  let failStart = false;
  let read: WorkbenchProvider["configuration"]["modelContext"]["read"] | undefined;
  let singleFile: WorkbenchProvider["singleFile"];
  let tools: WorkbenchProvider["tools"];
  const disposed: number[] = [];
  const started = deferred();
  const releaseStart = deferred();
  let holdStart = false;
  const graph = () => defineReloadableNodeGraph([
    ReloadableNode.define<object, Objects, never>()({
      access: "agent", children: [], description: "Provider fixture", lifecycle: "atomic",
      provides: ["codexProvider", "openCodeProvider"], requires: [], safeAll: true,
      scope: "server:codex/def", sources: "",
      create: () => {
        const current = ++generation;
        const currentRead = read;
        return {
          registrations: {
            codexProvider: {
              singleFile,
              tools,
              threads: { readLatest: unused, messageAgent: unused, history: { materialize: unused, questionnaires: unused, steers: unused, browse: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, page: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, materialize: unused },
              configuration: { models: { read: unused }, guidance: { contains: unused }, modelContext: {
                read: currentRead ?? (async () => [{ model: String(current), defaultTokens: 1000, maximumTokens: 2000 }]),
              } },
            },
            openCodeProvider: {
              threads: { readLatest: unused, messageAgent: unused, history: { materialize: unused, questionnaires: unused, steers: unused, browse: unused }, admitTurn: unused, latestTurn: unused, create: unused, list: unused, read: unused, page: unused, submit: unused, rename: unused, compact: unused, interrupt: unused, materialize: unused },
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
      scope: "server:consumer", sources: "",
      create: (_context, { run }) => ({
        registrations: { providers: new WorkbenchProviderDispatcher(run) },
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
  };
}

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
    patchClaims: unused, executeReadOnly: unused, describe: unused, caller: unused, shell: unused,
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
