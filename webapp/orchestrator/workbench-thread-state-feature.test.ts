/* No production exports. Tests protect provider normalization and progressive per-harness reconciliation. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchThreadStateFeature, { mapProviderActivityNotification, mapProviderLifecycleNotification, normalizeProviderSidebarEntry, normalizeSubagentProviderLifecycle } from "./WorkbenchThreadStateFeature";
import type { WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("provider sidebar normalization converts seconds at the reloadable feature boundary", () => {
  const entry = normalizeProviderSidebarEntry("codex", { id: "thread", status: { type: "idle" }, updatedAt: 1_723_456_789 });
  assert.equal(entry?.activityAt, 1_723_456_789_000);
});

test("provider sidebar normalization replaces identifier titles with first-message previews", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const entry = normalizeProviderSidebarEntry("codex", { id, name: id, preview: "First request", status: { type: "idle" }, updatedAt: 1 });
  assert.equal(entry?.title, "First request");
});

test("inactive subagents remain completed but unsettled until an explicit settlement overlay exists", () => {
  assert.deepEqual(normalizeSubagentProviderLifecycle({ kind: "completed", reason: "providerInactive", settled: true }), {
    kind: "completed",
    reason: "providerInactive",
    settled: false,
  });
  const explicitlySettled = { agent: { agentStatus: "completed" as const, turnId: "turn" }, kind: "completed" as const, reason: "agentCompleted" as const, settled: true };
  assert.equal(normalizeSubagentProviderLifecycle(explicitlySettled), explicitlySettled);
});

test("provider lifecycle notification mapping is exact and bounded", () => {
  assert.deepEqual(mapProviderLifecycleNotification({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "completed" } } }), {
    event: { kind: "turnCompleted", status: "completed", turnId: "turn" }, threadId: "child",
  });
  assert.deepEqual(mapProviderLifecycleNotification({ method: "questionnaire/requested", params: { requestKey: "question", threadId: "child", turnId: null } }), {
    event: { kind: "pendingInput", requestKey: "question", turnId: null }, threadId: "child",
  });
  assert.equal(mapProviderLifecycleNotification({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "inProgress" } } }), null);
});

test("provider activity mapping observes meaningful cross-provider work without token deltas", () => {
  assert.equal(mapProviderActivityNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }), "thread");
  assert.equal(mapProviderActivityNotification({ method: "item/completed", params: { threadId: "thread", turnId: "turn" } }), "thread");
  assert.equal(mapProviderActivityNotification({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn" } }), null);
});

test("provider reconciliation starts concurrently and publishes each successful harness without waiting for failures", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-feature-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
  const starts: string[] = [];
  const codexCursors: Array<string | null> = [];
  const codexRequests: Array<Record<string, unknown>> = [];
  let releaseCodexNext = () => undefined;
  const codexNextGate = new Promise<void>((resolve) => { releaseCodexNext = resolve; });
  let releaseCopilot = () => undefined;
  const copilotGate = new Promise<void>((resolve) => { releaseCopilot = resolve; });
  const feature = new WorkbenchThreadStateFeature({
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    listSubagents: async () => ({
      subagents: [{
        createdAt: 1,
        cwd: "C:/projects/project",
        directSubagentIndex: 0,
        harness: "codex",
        name: "Child",
        parentThreadId: "parent",
        profileId: "default",
        profileName: "Default",
        projectId: "project",
        threadId: "child",
        title: "Child",
        updatedAt: 2,
      }],
    }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    requestHarness: async (harness, request) => {
      const params = request.params as { cursor?: string | null };
      if (!starts.includes(harness)) starts.push(harness);
      if (harness === "codex") {
        codexRequests.push(request);
        codexCursors.push(params.cursor ?? null);
        if (params.cursor) {
          await codexNextGate;
          return { id: request.id ?? null, result: { data: [{ id: "parent", name: "Parent", status: { type: "idle" }, updatedAt: 3 }], nextCursor: null } };
        }
        return { id: request.id ?? null, result: { data: [{ id: "child", name: "Child provider", status: { type: "idle" }, updatedAt: 2 }], nextCursor: "codex-next" } };
      }
      if (harness === "copilot") {
        await copilotGate;
        return { id: request.id ?? null, result: { data: [{ id: "copilot-thread", name: "Copilot", status: { type: "idle" }, updatedAt: 4 }], nextCursor: null } };
      }
      return { error: { code: -32000, message: "OpenCode unavailable" }, id: request.id ?? null };
    },
    resolveProjectById: async () => ({ id: "project", rootPath: "C:/projects/project" }),
    resolveProjectFromCwd: async () => { throw new Error("Not used by this test."); },
    storageRoot,
  });

  await feature.controller.open("observer", "project");
  await waitFor(() => starts.length === 3, "Provider reconciliations did not start concurrently.");
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.harness === "codex")), "Codex snapshot did not publish while Copilot remained pending.");
  assert.deepEqual(new Set(starts), new Set(["codex", "copilot", "opencode"]));
  assert.deepEqual(codexCursors, [null, "codex-next"]);
  assert.equal(codexRequests[0]?.workbenchRequestSource, "autoRefresh");
  assert.deepEqual(codexRequests[0]?.params, {
    archived: false,
    cursor: null,
    cwd: "C:/projects/project",
    limit: 50,
    sortDirection: "desc",
    sortKey: "updated_at",
    useStateDbOnly: true,
  });
  const progressive = [...publications].reverse().find((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind === "subagent"));
  assert.equal(progressive && "entries" in progressive ? progressive.freshness : null, "partial");

  releaseCodexNext();
  releaseCopilot();
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.error?.includes("opencode")), "Final partial provider result did not publish.");
  const final = [...publications].reverse().find((snapshot) => "entries" in snapshot);
  assert.ok(final && "entries" in final);
  assert.equal(final.freshness, "partial");
  assert.match(final.error ?? "", /opencode: OpenCode unavailable/u);
  assert.equal(final.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "copilot-thread"), true);
  assert.equal(final.entries.some((entry) => entry.entryKind === "subagent" && entry.identity.threadId === "child"), true);
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("deep provider pages serialize across projects while both newest pages start immediately", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-pagination-"));
  const firstDeepGate = deferred<void>();
  const secondDeepGate = deferred<void>();
  const firstPages: string[] = [];
  const deepPages: string[] = [];
  let activeDeepPages = 0;
  let maximumActiveDeepPages = 0;
  const feature = new WorkbenchThreadStateFeature({
    getProjectCatalog: () => ({ data: [], rootPath: "C:/projects" }),
    listSubagents: async () => ({ subagents: [] }),
    projectState: {
      getCurrentUpdate: () => null,
      handleRequest: async () => ({ accepted: true }),
      observe: () => () => undefined,
    },
    publish: () => undefined,
    requestHarness: async (harness, request) => {
      const params = request.params as { cursor?: string | null; cwd: string };
      if (harness !== "codex") return { id: request.id ?? null, result: { data: [], nextCursor: null } };
      if (!params.cursor) {
        firstPages.push(params.cwd);
        return { id: request.id ?? null, result: { data: [], nextCursor: "next" } };
      }
      deepPages.push(params.cwd);
      activeDeepPages += 1;
      maximumActiveDeepPages = Math.max(maximumActiveDeepPages, activeDeepPages);
      await (deepPages.length === 1 ? firstDeepGate.promise : secondDeepGate.promise);
      activeDeepPages -= 1;
      return { id: request.id ?? null, result: { data: [], nextCursor: null } };
    },
    resolveProjectById: async (projectId) => ({ id: projectId, rootPath: `C:/projects/${projectId}` }),
    resolveProjectFromCwd: async () => { throw new Error("Not used by this test."); },
    storageRoot,
  });

  await Promise.all([feature.controller.open("a", "project-a"), feature.controller.open("b", "project-b")]);
  await waitFor(() => firstPages.length === 2 && deepPages.length === 1, "Newest pages did not start before serialized continuation work.");
  assert.deepEqual(new Set(firstPages), new Set(["C:/projects/project-a", "C:/projects/project-b"]));
  assert.equal(maximumActiveDeepPages, 1);
  firstDeepGate.resolve();
  await waitFor(() => deepPages.length === 2, "Second deep page did not start after the first completed.");
  assert.equal(maximumActiveDeepPages, 1);
  secondDeepGate.resolve();
  await feature.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});
