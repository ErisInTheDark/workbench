/*
 * No production exports. Protect OpenCode profile admission, failure propagation and thread reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { OpenCodeBridge } from "./opencode-bridge";
import type OpenCodeAppServer from "./OpenCodeAppServer";
import type { OrchestratorReloadableModules } from "./orchestrator-runtime-objects";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

test("OpenCode applies a captured profile only to accepted inactive turns", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text =>
    text === "[opencode-bridge] Native rejected\n" || text === "[opencode-bridge] session status read failed: Status unavailable\n");
  context.after(() => assert.equal(diagnostics.length, 2));
  for (const mode of ["fresh", "continuation", "active", "active-race", "rejected", "status-failure"]) {
    const calls: string[] = [];
    const settings = { harness: "opencode" as const, model: "provider/fresh", agentPath: "fresh-agent", agentSource: "project" as const, reasoningEffort: "high", serviceTier: null };
    const bridge = new OpenCodeBridge({
      appServer: {} as OpenCodeAppServer, projectRoot: "C:/repo", onNotification() {},
      getReloadableModules: () => ({
        opencodeLiveThreadState: { createOpenCodeLiveThreadState: () => ({ sessions: new Map() }) },
        opencodeThreadState: {
          formatPromptFromInput: () => "hello",
          opencodeSessionToThread: () => ({
            ...thread(), status: mode === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
            turns: mode === "fresh" ? [] : [{ id: "previous" }],
          }),
        },
      }) as unknown as OrchestratorReloadableModules,
      profiles: {
        captureCreationProfile: async () => { throw new Error("Unexpected creation"); },
        installCreatedProfile: async () => { throw new Error("Unexpected creation"); },
        withProviderProfileAdmission: async (_harness, _thread, admit, _signal, refresh) => {
          assert.equal(refresh, mode !== "fresh");
          calls.push("candidate");
          if (mode === "active-race") owner.sessionStatuses.set("thread", { type: "busy" });
          const outcome = await admit({ cwd: "C:/repo", projectId: ProjectIdSchema.parse("project"), subagentName: null, selection: { kind: "custom", settings } });
          if (outcome.accepted) calls.push("commit");
          return { ...outcome, profilePersistenceError: null };
        },
      },
    });
    const owner = bridge as unknown as {
      ensureClient(): Promise<object>;
      buildTurnSystemPrompt(message: { workbenchPromptContext?: { agentPath?: string } }): Promise<string>;
      updateDefaultThreadTitleFromPrompt(): Promise<void>;
      scheduleThreadSnapshotRefresh(): void;
      sessionStatuses: Map<string, { type: string }>;
    };
    const active = mode === "active" || mode === "active-race";
    owner.ensureClient = async () => ({ session: {
      get: async () => ({ data: { id: "thread", directory: "C:/repo" } }),
      messages: async () => ({ data: [] }),
      status: async () => {
        if (mode === "status-failure") throw new Error("Status unavailable");
        return { data: {} };
      },
      promptAsync: async (params: { model?: object; variant?: string; system?: string }) => {
        calls.push("send");
        assert.deepEqual(params.model, active ? undefined : { providerID: "provider", modelID: "fresh" });
        assert.equal(params.variant, active ? undefined : "high");
        assert.equal(params.system, active ? undefined : "fresh-agent");
        return mode === "rejected" ? { error: { message: "Native rejected" } } : { data: {} };
      },
    } });
    owner.buildTurnSystemPrompt = async message => message.workbenchPromptContext?.agentPath ?? "missing-agent";
    owner.updateDefaultThreadTitleFromPrompt = async () => {};
    owner.scheduleThreadSnapshotRefresh = () => {};
    try {
      const response = await bridge.handleRequest({
        id: 1, method: "turn/start",
        params: { threadId: "thread", model: "provider/stale", effort: "low", input: [{ type: "text", text: "hello", text_elements: [] }] },
      });
      assert.equal(Boolean(response.error), mode === "rejected" || mode === "status-failure");
      assert.deepEqual(calls, mode === "status-failure" ? [] : mode === "active" ? ["send"]
        : ["candidate", "send", ...(!active && mode !== "rejected" ? ["commit"] : [])]);
    } finally { await bridge.stop(); }
  }
});

test("OpenCode SDK rejection is not reported as an accepted turn", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text === "[opencode-bridge] Native prompt rejected\n");
  context.after(() => assert.equal(diagnostics.length, 1));
  const bridge = new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer, projectRoot: "C:/repo", onNotification() {},
    getReloadableModules: () => ({
      opencodeLiveThreadState: { createOpenCodeLiveThreadState: () => ({ sessions: new Map() }) },
      opencodeThreadState: { formatPromptFromInput: () => "hello" },
    }) as unknown as OrchestratorReloadableModules,
  });
  const owner = bridge as unknown as {
    ensureClient(): Promise<object>;
    buildTurnSystemPrompt(): Promise<null>;
    updateDefaultThreadTitleFromPrompt(): Promise<void>;
    scheduleThreadSnapshotRefresh(): void;
  };
  let refreshes = 0;
  owner.ensureClient = async () => ({ session: { promptAsync: async () => ({ error: { message: "Native prompt rejected" }, data: undefined }) } });
  owner.buildTurnSystemPrompt = async () => null;
  owner.updateDefaultThreadTitleFromPrompt = async () => {};
  owner.scheduleThreadSnapshotRefresh = () => { refreshes++; };
  const response = await bridge.handleRequest({ id: 1, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "hello", text_elements: [] }] } });
  assert.match(response.error?.message ?? "", /Native prompt rejected/);
  assert.equal(refreshes, 0);
});

function thread(): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id: "thread", modelProvider: "opencode", name: null,
    model: null, projectId: null, reasoningEffort: null,
    parentThreadId: null, path: null, preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: "session",
    source: "appServer", status: { type: "idle" }, threadSource: null, turns: [], updatedAt: 1,
  };
}

test("a read from the expired bridge generation cannot alter state after rollback", async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (value: object) => void;
  const metadata = new Promise<object>((resolve) => { finish = resolve; });
  const bridge = new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer,
    projectRoot: "C:/repo",
    onNotification() {},
    getReloadableModules: () => ({
      opencodeLiveThreadState: { createOpenCodeLiveThreadState: () => ({ sessions: new Map() }) },
      opencodeThreadState: { opencodeSessionToThread: () => thread() },
    }) as unknown as OrchestratorReloadableModules,
  });
  (bridge as unknown as { ensureClient(): Promise<object> }).ensureClient = async () => ({ session: {
    get: () => { entered(); return metadata; },
    status: async () => ({ data: {} }),
  } });
  const request = bridge.handleRequest({
    id: 1, method: "thread/read", params: { threadId: "thread", includeTurns: false },
  });
  await reading;
  bridge.expireRuntimeDrain();
  await bridge.detachForReload();
  bridge.resumeAfterFailedReload();
  finish({ data: { id: "thread", directory: "C:/late" } });
  assert.match((await request).error?.message ?? "", /retired/u);
  assert.equal((await bridge.detachForReload()).sessionDirectories.has("thread"), false);
  await bridge.stop();
});

test("OpenCode metadata lookup does not fetch transcript messages", async () => {
  const bridge = new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer, projectRoot: "C:/repo", onNotification() {},
    getReloadableModules: () => ({
      opencodeLiveThreadState: { createOpenCodeLiveThreadState: () => ({ sessions: new Map() }) },
      opencodeThreadState: { opencodeSessionToThread: ({ messages }: { messages: object[] }) => {
        assert.deepEqual(messages, []);
        return thread();
      } },
    }) as OrchestratorReloadableModules,
  });
  let metadataReads = 0;
  (bridge as unknown as { ensureClient(): Promise<object> }).ensureClient = async () => ({ session: {
    get: async () => { metadataReads++; return { data: { id: "thread", directory: "C:/repo" } }; },
    status: async () => ({ data: {} }),
    messages: async () => { throw new Error("Metadata lookup fetched transcript bodies"); },
  } });
  const result = await bridge.handleRequest({ id: 1, method: "thread/read", params: { threadId: "thread", includeTurns: false } });
  assert.equal(result.error, undefined);
  assert.equal(metadataReads, 1);
});

test("maps the Workbench first page to the existing OpenCode thread read and rejects continuation", async () => {
  const bridge = new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer,
    getReloadableModules: () => ({
      opencodeLiveThreadState: {
        createOpenCodeLiveThreadState: () => ({ sessions: new Map() }),
      },
    }) as OrchestratorReloadableModules,
    onNotification() {},
    projectRoot: "C:/repo",
  });
  const pageOwner = bridge as unknown as {
    readThread(threadId: string, directory: string): Promise<{
      model: string;
      modelProvider: string;
      reasoningEffort: string;
      serviceTier: null;
      thread: Thread;
    }>;
  };
  pageOwner.readThread = async (threadId, directory) => {
    assert.deepEqual({ directory, threadId }, { directory: "C:/chosen", threadId: "thread" });
    return {
      model: "opencode-model",
      modelProvider: "opencode",
      reasoningEffort: "high",
      serviceTier: null,
      thread: thread(),
    };
  };

  const first = await bridge.handleRequest({
    id: 1,
    method: "workbench/thread/page/read",
    params: { cursor: null, cwd: "C:/chosen", threadId: "thread" },
  });
  assert.deepEqual(first.result, {
    browseResultEntries: [],
    model: "opencode-model",
    nextCursor: null,
    questionnaireEntries: [],
    reasoningEffort: "high",
    serviceTier: null,
    steerEntries: [],
    thread: thread(),
  });

  const continuation = await bridge.handleRequest({
    id: 2,
    method: "workbench/thread/page/read",
    params: { cursor: "turn", threadId: "thread" },
  });
  assert.match(continuation.error?.message ?? "", /do not have a continuation cursor/u);
});
