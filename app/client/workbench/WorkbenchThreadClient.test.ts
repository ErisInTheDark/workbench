/* Exports: none. Tests protect thread selection by observation admission, open supersession and failure, local drafts, observed subagents, and model catalogue events. */

import assert from "node:assert/strict";
import test from "node:test";

import { DraftIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchWorkspaceClient from "./app/WorkbenchWorkspaceClient";
import WorkbenchThreadClient, { type WorkbenchThreadProject } from "./WorkbenchThreadClient.ts";

const project: WorkbenchThreadProject = {
  id: ProjectIdSchema.parse("project"), name: "repo", rootPath: "C:/repo",
  roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath: "C:/repo" }],
};

type ObserveParams = { projectId: string; subscriptionId: string; target: { harness: string; threadId: string; kind: string } };
type ThreadEventListener = (notification: { method: string; params?: unknown }, harness: string, daemonId?: string) => void;

function threadEntry(threadId: string) {
  return {
    activityAt: 1, entryKind: "thread", title: "Thread", identity: { harness: "codex", threadId },
    metadata: { archived: false, pinned: true, snoozed: false },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
  };
}

function subagentEntry(parentThreadId: string, threadId: string) {
  return {
    activityAt: 2, title: "Child", entryKind: "subagent", identity: { harness: "codex", threadId },
    createdAt: 1, cwd: "C:/repo", directSubagentIndex: 0, name: "Lily", parentThreadId, pinned: false,
    profileId: "worker", profileName: "Worker", projectId: "project", updatedAt: 2,
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
  };
}

/** A workspace edge whose thread observations stay pending until the test answers them. */
function fakeWorkspace() {
  const observations: Array<{ params: ObserveParams; resolve: (entries: unknown[]) => void; reject: (error: Error) => void }> = [];
  const released: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const threadEvents = new Set<ThreadEventListener>();
  const workspace = {
    rpc: { onReconnect: () => () => {} },
    connect: async () => {},
    onDisconnect: () => () => {},
    onWorkbenchNotification: () => () => {},
    onThreadEvent: (listener: ThreadEventListener) => {
      threadEvents.add(listener);
      return () => { threadEvents.delete(listener); };
    },
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "models/list") return { data: [] };
      throw new Error(`unexpected ${method}`);
    },
    observeThread: (params: ObserveParams) => new Promise((resolve, reject) => {
      observations.push({
        params, reject,
        resolve: entries => resolve({ observation: {
          ...params, entries, error: null, freshness: "fresh", revision: 1, version: 2, updateKind: "threadObservation",
        } }),
      });
    }),
    releaseThread: async (subscriptionId: string) => { released.push(subscriptionId); },
    observe: (query: { kind: string }) => {
      if (query.kind !== "accountLimits") throw new Error(`Unexpected ${query.kind} observation.`);
      return { getSnapshot: () => ({ phase: "current", failure: null, value: null }), release: () => {} };
    },
  } as unknown as WorkbenchWorkspaceClient;
  return {
    workspace, observations, released, requests,
    notifyThreadEvent: (method: string, harness: string) => {
      for (const listener of threadEvents) listener({ method, params: {} }, harness);
    },
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve));
}

function withClient(run: (client: ReturnType<typeof WorkbenchThreadClient>, edge: ReturnType<typeof fakeWorkspace>) => Promise<void>) {
  return async () => {
    const edge = fakeWorkspace();
    const client = WorkbenchThreadClient({ workspace: edge.workspace });
    try { await run(client, edge); } finally { client.dispose(); }
  };
}

test("opening a thread selects it once its observation admits it, without reading its page", withClient(async (client, edge) => {
  const opening = client.openThread("thread", { harness: "codex", project });
  await settle();
  assert.equal(edge.observations.length, 1);
  assert.equal(client.getSnapshot().currentThreadId, "", "nothing is selected before admission");
  edge.observations[0]!.resolve([threadEntry("thread")]);
  assert.deepEqual(await opening, { kind: "opened" });
  assert.equal(client.getSnapshot().currentThreadId, "thread");
  assert.equal(client.getSnapshot().currentThread, null);
  assert.deepEqual(edge.requests, [], "turn content ships once, through the view's own transcript subscription");
}));

test("a newer selection supersedes a pending open and its late admission cannot reclaim the selection", withClient(async (client, edge) => {
  const opening = client.openThread("a", { harness: "codex", project });
  await settle();
  const draft = client.createThread("codex", DraftIdSchema.parse("draft"), { project });
  edge.observations[0]!.resolve([threadEntry("a")]);
  assert.deepEqual(await opening, { kind: "superseded" });
  assert.equal(client.getSnapshot().currentThreadId, draft.id);
  assert.equal(client.getSnapshot().currentThread?.id, draft.id);
}));

test("failed opens report their exact failure and leave the current selection alone", async t => {
  t.mock.method(console, "warn", () => {});
  await withClient(async (client, edge) => {
    const draft = client.createThread("codex", DraftIdSchema.parse("draft"), { project });
    const rejected = client.openThread("missing", { harness: "codex", project });
    await settle();
    edge.observations[0]!.reject(new Error("transcript ownership conflict"));
    assert.deepEqual(await rejected, { kind: "failure", message: "transcript ownership conflict" });
    const absent = client.openThread("other", { harness: "codex", project });
    await settle();
    edge.observations[1]!.resolve([]);
    assert.deepEqual(await absent, { kind: "failure", message: "This thread is no longer available." });
    assert.equal(client.getSnapshot().currentThreadId, draft.id);
  })();
});

test("the selected thread publishes its observed subagents until the selection clears", withClient(async (client, edge) => {
  const opening = client.openThread("thread", { harness: "codex", project });
  await settle();
  edge.observations[0]!.resolve([threadEntry("thread"), subagentEntry("thread", "child")]);
  await opening;
  assert.deepEqual(client.getSnapshot().subagents.map(subagent => [subagent.parentThreadId, subagent.threadId]), [["thread", "child"]]);
  client.clearThreadSelection();
  await settle();
  assert.deepEqual(client.getSnapshot().subagents, []);
  assert.equal(client.getSnapshot().currentThreadId, "");
  assert.deepEqual(edge.released, [edge.observations[0]!.params.subscriptionId], "clearing releases the selected observation");
}));

test("drafts own their settings; a provider change re-keys the draft without moving selection", withClient(async client => {
  const selected = client.createThread("codex", DraftIdSchema.parse("selected"), { project });
  const draft = client.createThread("codex", DraftIdSchema.parse("draft"), { project, select: false });
  assert.equal(draft.cwd, "C:/repo");
  const store = client.getThreadStore("project", { kind: "draft", draftId: draft.id });
  const release = store.acquire("view");
  store.actions.changeSettings({
    agentPath: null, agentSource: null, harness: "opencode", model: "draft-model", reasoningEffort: "high", serviceTier: "fast",
  });
  const document = store.getSlice("summary").draftDocument;
  assert.equal(document?.harness, "opencode");
  assert.equal(document?.model, "draft-model");
  assert.equal(document?.reasoningEffort, "high");
  assert.equal(document?.serviceTier, "fast");
  const documents = client.getSnapshot().threadDocuments;
  assert.equal(documents.keysByThreadId.draft, "opencode:draft");
  assert.equal(documents.documentsByKey["codex:draft"], undefined);
  assert.equal(client.getSnapshot().currentThreadId, selected.id);
  assert.equal(documents.selectedThreadKey, "codex:selected");

  client.setDraftThreadHarness("opencode");
  assert.equal(client.getSnapshot().threadDocuments.selectedThreadKey, "opencode:selected", "the selected draft follows its new key");
  release();
}));

test("provider catalogue events invalidate only their model cache and notify mounted consumers", withClient(async (client, edge) => {
  const updates: string[] = [];
  const unsubscribe = client.subscribeModelUpdates(harness => { updates.push(harness); });
  await client.listModels("codex");
  await client.listModels("opencode");
  edge.notifyThreadEvent("models/updated", "opencode");
  assert.deepEqual(updates, ["opencode"]);
  await client.listModels("opencode");
  await client.listModels("codex");
  const reads = (provider: string) => edge.requests.filter(request => request.method === "models/list"
    && (request.params as { provider?: string }).provider === provider).length;
  assert.equal(reads("opencode"), 2);
  assert.equal(reads("codex"), 1);
  unsubscribe();
  edge.notifyThreadEvent("models/updated", "opencode");
  assert.deepEqual(updates, ["opencode"]);
}));

test("published runtime reads stay stable until the client publishes new state", withClient(async client => {
  const initial = client.getPublishedSnapshot();
  assert.strictEqual(client.getPublishedSnapshot(), initial);
  client.createThread("codex", DraftIdSchema.parse("draft"), { project });
  const published = client.getPublishedSnapshot();
  assert.notStrictEqual(published, initial);
  assert.strictEqual(client.getPublishedSnapshot(), published);
  assert.equal(published.currentThread?.id, "draft");
}));
