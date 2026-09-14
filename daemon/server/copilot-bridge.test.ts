/*
 * Exports:
 * - No production exports; protect Copilot admission, instruction filtering and thread-page translation.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { CopilotBridge } from "./copilot-bridge";
import type { DaemonReloadableModules } from "./daemon-runtime-objects";
import type { JsonRpcNotification } from "./bridge-types";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type { CopilotThreadState } from "./copilot-thread-state";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

test("Copilot commits inactive configuration only after send and leaves active input unchanged", async () => {
  for (const [active, reject] of [[false, false], [true, false], [false, true]]) {
    const calls: string[] = [];
    const nativeThread = thread();
    if (active) nativeThread.status = { type: "active", activeFlags: [] };
    const bridge = new CopilotBridge({
      projectRoot: "C:/repo", onNotification() {},
      getReloadableModules: () => ({ copilotThreadState: { formatPromptFromInput: () => "hello" } }) as unknown as DaemonReloadableModules,
      profiles: {
        captureCreationProfile: async () => { throw new Error("Unexpected creation"); },
        installCreatedProfile: async () => { throw new Error("Unexpected creation"); },
        withProviderProfileAdmission: async (_harness, _thread, admit) => {
          calls.push("candidate");
          const outcome = await admit({
            cwd: "C:/repo", projectId: ProjectIdSchema.parse("project"), subagentName: null,
            selection: { kind: "custom", settings: { harness: "copilot", model: "fresh", agentPath: "agent", agentSource: "project", reasoningEffort: "high", serviceTier: null } },
          });
          if (outcome.accepted) calls.push("commit");
          return { ...outcome, profilePersistenceError: null };
        },
      },
    });
    const owner = bridge as unknown as { ensureThreadState(threadId: string, model?: string | null): Promise<object> };
    owner.ensureThreadState = async (_id, model) => {
      if (model) { assert.equal(model, "fresh"); calls.push("configure"); }
      return { state: { thread: nativeThread }, session: {
        disconnect: async () => { calls.push("disconnect"); },
        send: async () => { calls.push("send"); if (reject) throw new Error("Native send rejected"); },
      } };
    };
    const response = await bridge.handleRequest({ id: 1, method: "turn/start", params: { threadId: "thread", model: "stale", input: [{ type: "text", text: "hello", text_elements: [] }] } });
    if (reject) assert.match(response.error?.message ?? "", /Native send rejected/);
    else assert.equal(response.error, undefined);
    assert.deepEqual(calls, active ? ["send"] : ["candidate", "disconnect", "configure", "send", ...(!reject ? ["commit"] : [])]);
  }
});

function thread(): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id: "thread", modelProvider: "copilot", name: null,
    model: null, projectId: null, reasoningEffort: null,
    parentThreadId: null, path: null, preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: "session",
    source: "appServer", status: { type: "idle" }, threadSource: null, turns: [], updatedAt: 1,
  };
}

test("Copilot metadata lookup does not resume a session or fetch its messages", async () => {
  let metadataReads = 0;
  const bridge = new CopilotBridge({
    projectRoot: "C:/repo", onNotification() {},
    getReloadableModules: () => ({ copilotThreadState: { metadataToThread: () => thread() } }) as unknown as DaemonReloadableModules,
  });
  const owner = bridge as unknown as { ensureClient(): Promise<object>; ensureThreadState(): Promise<never> };
  owner.ensureClient = async () => ({ getSessionMetadata: async () => { metadataReads++; return { sessionId: "thread" }; } });
  owner.ensureThreadState = async () => { throw new Error("Metadata lookup resumed a provider session"); };
  const result = await bridge.handleRequest({ id: 1, method: "thread/read", params: { threadId: "thread", includeTurns: false } });
  assert.equal(result.error, undefined);
  assert.equal(metadataReads, 1);
});

test("session publication waits for structural admission and stop drains queued deltas", async () => {
  const emitted: JsonRpcNotification[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let listener: (event: SessionEvent) => void = () => { throw new Error("Session listener missing"); };
  let unsubscribed = false;
  let admissions = 0;
  const bridge = new CopilotBridge({
    getReloadableModules: () => ({
      copilotThreadState: { applyCopilotEvent(_state: CopilotThreadState, event: SessionEvent, _live: boolean, notify: (event: JsonRpcNotification) => void) {
        notify({ method: event.type === "assistant.message" ? "item/started" : "item/agentMessage/delta", params: { content: event.data } });
      } },
    }) as DaemonReloadableModules,
    admitNotifications: async () => { admissions += 1; started(); await gate; },
    onNotification: (event) => emitted.push(event),
    projectRoot: await mkdtemp(path.join(tmpdir(), "workbench-copilot-identity-")),
  });
  const session = { on(callback: typeof listener) {
    listener = callback;
    return () => { unsubscribed = true; };
  } } as CopilotSession;
  const owner = bridge as unknown as { bindSessionEvents(threadId: string, session: CopilotSession, state: CopilotThreadState): Promise<void> };
  await owner.bindSessionEvents("thread", session, {} as CopilotThreadState);
  listener({ type: "assistant.message", data: { content: "start" } } as SessionEvent);
  await entered;
  listener({ type: "assistant.message_delta", data: { deltaContent: "first" } } as SessionEvent);
  listener({ type: "assistant.message_delta", data: { deltaContent: "second" } } as SessionEvent);
  const stopped = bridge.stop();
  assert.equal(unsubscribed, true);
  assert.deepEqual(emitted, []);
  release();
  await stopped;
  assert.equal(admissions, 1);
  assert.deepEqual(emitted.map((event) => event.params), [
    { content: { content: "start" } },
    { content: { deltaContent: "first" } },
    { content: { deltaContent: "second" } },
  ]);
});

test("failed session identity publication surfaces the affected thread and does not stall the next batch", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("[copilot-bridge] event admission failed: Identity write failed"));
  context.after(() => assert.equal(diagnostics.length, 1));
  const emitted: JsonRpcNotification[] = [];
  let listener!: (event: SessionEvent) => void;
  let rejectAdmission = true;
  const bridge = new CopilotBridge({
    projectRoot: await mkdtemp(path.join(tmpdir(), "workbench-copilot-identity-failure-")),
    getReloadableModules: () => ({ copilotThreadState: {
      applyCopilotEvent(_state: CopilotThreadState, _event: SessionEvent, _live: boolean, notify: (event: JsonRpcNotification) => void) {
        notify({ method: "item/started", params: { threadId: "thread" } });
      },
    } }) as DaemonReloadableModules,
    admitNotifications: async () => {
      if (rejectAdmission) { rejectAdmission = false; throw new Error("Identity write failed"); }
    },
    onNotification: (event) => emitted.push(event),
  });
  const session = { on(callback: typeof listener) { listener = callback; return () => {}; } } as CopilotSession;
  await (bridge as unknown as { bindSessionEvents(id: string, session: CopilotSession, state: CopilotThreadState): Promise<void> })
    .bindSessionEvents("thread", session, {} as CopilotThreadState);
  listener({ type: "assistant.message", data: { content: "one" } } as SessionEvent);
  listener({ type: "assistant.message", data: { content: "two" } } as SessionEvent);
  await bridge.stop();
  assert.deepEqual(emitted, [
    { method: "thread/status/changed", params: { threadId: "thread", status: { type: "systemError" } } },
    { method: "item/started", params: { threadId: "thread" } },
  ]);
});

test("filters the final joined Copilot system message with bridge-owned selectors", async () => {
  const source = await readFile(path.join(__dirname, "copilot-bridge.ts"), "utf8");
  const joinIndex = source.indexOf("const content = joinSystemMessageSections");
  const filterIndex = source.indexOf("filterWorkbenchInstructionContent(content", joinIndex);
  assert.ok(joinIndex >= 0);
  assert.ok(filterIndex > joinIndex);
  assert.match(source.slice(filterIndex, filterIndex + 500), /harness: "copilot"/u);
  assert.match(source.slice(filterIndex, filterIndex + 500), /shell: process\.platform/u);
});

test("maps the Workbench first page to the existing Copilot thread read and rejects continuation", async () => {
  const bridge = new CopilotBridge({
    getReloadableModules: () => ({}) as DaemonReloadableModules,
    onNotification() {},
    projectRoot: "C:/repo",
  });
  const pageOwner = bridge as unknown as {
    readThread(
      threadId: string,
      model: string | null,
      reasoningEffort: string | null,
      agentPath: string | null,
      workbenchOrigin: string | null,
      projectId: string | null,
      promptContext: null,
    ): Promise<{ model: string; modelProvider: string; reasoningEffort: null; thread: Thread }>;
  };
  pageOwner.readThread = async (threadId, model, reasoningEffort, agentPath, workbenchOrigin, projectId, promptContext) => {
    assert.deepEqual(
      { agentPath, model, projectId, promptContext, reasoningEffort, threadId, workbenchOrigin },
      { agentPath: null, model: null, projectId: null, promptContext: null, reasoningEffort: null, threadId: "thread", workbenchOrigin: null },
    );
    return { model: "copilot-model", modelProvider: "copilot", reasoningEffort: null, thread: thread() };
  };

  const first = await bridge.handleRequest({
    id: 1,
    method: "workbench/thread/page/read",
    params: { cursor: null, threadId: "thread" },
  });
  assert.deepEqual(first.result, {
    browseResultEntries: [],
    model: "copilot-model",
    nextCursor: null,
    questionnaireEntries: [],
    reasoningEffort: null,
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
