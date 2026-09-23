/*
 * Exports:
 * - No production exports; Node tests protect route freshness, canonicalisation, failure publication, and pinned draft ownership.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchRouteLoadResult } from "workbench-shared/types";
import {
  DraftIdSchema,
  ProjectIdSchema,
  ThreadReferenceSchema,
} from "workbench-shared/workbench/identity";
import {
  createHomeRoute,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type {
  WorkbenchThreadDraft,
  WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchNavigationController, {
  type WorkbenchNavigationPorts,
} from "./WorkbenchNavigationController.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitForRead(
  reads: Map<string, ReturnType<typeof deferred<WorkbenchRouteLoadResult>>>,
  threadId: string,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = reads.get(threadId);
    if (read) return read;
    await Promise.resolve();
  }
  throw new Error(`Expected navigation to open ${threadId}.`);
}

function project(id = "project") {
  return {
    id: ProjectIdSchema.parse(id),
    kind: "git" as const,
    lastCommitTimeMs: null,
    name: id,
    relativePath: id,
    rootPath: `C:/${id}`,
    roots: [],
  };
}

function threadRoute(threadId: string): WorkbenchRoute {
  return {
    ...createHomeRoute(),
    projectId: ProjectIdSchema.parse("project"),
    threadId,
    threadTarget: {
      harness: "codex",
      kind: "provider",
      threadId: ThreadReferenceSchema.parse(threadId),
    },
    view: "thread",
  };
}

function draft(): WorkbenchThreadDraft {
  return {
    attachments: [],
    clientUpdatedAt: 2,
    composerSettings: {
      agentPath: null,
      agentSource: null,
      harness: "codex",
      model: "",
      reasoningEffort: null,
      serviceTier: null,
    },
    createdAt: 1,
    draftId: DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    profileId: null,
    projectId: ProjectIdSchema.parse("owner"),
    prompt: "draft",
    updatedAt: 2,
  };
}

function createPorts(overrides: Partial<WorkbenchNavigationPorts> = {}): WorkbenchNavigationPorts {
  return {
    activateThreadControllers: () => undefined,
    applyDraft: () => undefined,
    clearSelection: () => undefined,
    createDraft: () => undefined,
    ensureProject: async () => "",
    failThread: () => undefined,
    getLocalEntries: () => [],
    getProject: projectId => project(projectId),
    getProjectEntries: () => [],
    guardNavigation: async apply => await apply(),
    hydrateSidebar: () => undefined,
    openFile: async () => true,
    openThread: async () => ({ ok: true }),
    readPinnedContext: async () => ({
      error: "missing",
      ok: false,
    }),
    receiveDraft: () => undefined,
    reportStatus: () => undefined,
    resolveDraftReferences: async () => false,
    resolveProjectId: projectId => projectId,
    resolveRoute: async route => route,
    ...overrides,
  };
}

test("overlapping thread opens publish only the latest route", async () => {
  const reads = new Map<string, ReturnType<typeof deferred<WorkbenchRouteLoadResult>>>();
  const controller = new WorkbenchNavigationController(createHomeRoute(), createPorts({
    openThread: async (threadId) => {
      const read = deferred<WorkbenchRouteLoadResult>();
      reads.set(threadId, read);
      return await read.promise;
    },
  }));

  const first = controller.applyRoute(threadRoute("first"));
  const firstRead = await waitForRead(reads, "first");
  const second = controller.applyRoute(threadRoute("second"));
  const secondRead = await waitForRead(reads, "second");
  firstRead.resolve({ ok: true });
  assert.deepEqual(await first, { ok: false });
  secondRead.resolve({ ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(controller.getSnapshot().route.threadId, "second");
});

test("new-thread navigation clears the prior selection before async project setup", async () => {
  const projectReady = deferred<string>();
  const events: string[] = [];
  const controller = new WorkbenchNavigationController(createHomeRoute(), createPorts({
    clearSelection: () => { events.push("clear"); },
    createDraft: () => { events.push("create"); },
    ensureProject: async () => await projectReady.promise,
  }));
  const route: WorkbenchRoute = {
    ...createHomeRoute(),
    projectId: ProjectIdSchema.parse("project"),
    threadTarget: { kind: "new" },
    view: "thread",
  };

  const navigation = controller.applyRoute(route);
  assert.deepEqual(events, ["clear"]);
  projectReady.resolve("");
  assert.deepEqual(await navigation, { ok: true });
  assert.deepEqual(events, ["clear", "create"]);
});

test("failed thread opens publish to the exact current owner", async () => {
  const failures: Array<{ error: string; projectId: string; threadId: string }> = [];
  const controller = new WorkbenchNavigationController(createHomeRoute(), createPorts({
    failThread: (projectId, target, error) => {
      failures.push({
        error,
        projectId,
        threadId: target.kind === "draft" ? target.draftId : target.threadId,
      });
    },
    openThread: async () => ({ error: "transcript unavailable", ok: false }),
  }));

  const result = await controller.applyRoute(threadRoute("failed"));

  assert.deepEqual(result, { error: "transcript unavailable", ok: false });
  assert.deepEqual(failures, [{
    error: "transcript unavailable",
    projectId: "project",
    threadId: "failed",
  }]);
});

test("project aliases become internal canonical scope without a public redirect", async () => {
  const controller = new WorkbenchNavigationController(createHomeRoute(), createPorts({
    resolveProjectId: projectId => projectId === "alias" ? "project" : projectId,
  }));
  const route: WorkbenchRoute = {
    ...createHomeRoute(),
    projectId: ProjectIdSchema.parse("alias"),
    view: "project",
  };

  const result = await controller.applyRoute(route);

  assert.deepEqual(result, { ok: true });
  assert.equal(controller.getSnapshot().route.projectId, "project");
});

test("home draft routes own a cloned pinned draft through later project moves", async () => {
  const source = draft();
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 2,
    draft: source,
    entryKind: "draft",
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "draft",
  };
  const controller = new WorkbenchNavigationController(createHomeRoute(), createPorts({
    getProjectEntries: () => [entry],
  }));
  const route: WorkbenchRoute = {
    ...createHomeRoute(),
    threadId: source.draftId,
    threadOwnerProjectId: source.projectId,
    threadTarget: { draftId: source.draftId, kind: "draft" },
    view: "thread",
  };

  assert.deepEqual(await controller.applyRoute(route), { ok: true });
  controller.movePinnedDraft("owner", "destination", source.draftId);
  source.prompt = "mutated outside";

  assert.equal(controller.getSnapshot().selectedPinnedThreadDraft?.projectId, "destination");
  assert.equal(controller.getSnapshot().selectedPinnedThreadDraft?.prompt, "draft");
});
