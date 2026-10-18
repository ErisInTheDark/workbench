/*
 * Exports:
 * - No production exports; tests protect project-qualified reads, title-history actions and hover-before-navigation store ownership.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import type { WorkbenchClientController } from "./workbench-client-context";
import { useThread } from "./use-thread";
import ThreadStore, { type ThreadStoreActions } from "../../workbench/thread/ThreadStore";
import WorkbenchProjectNavigation from "../../workbench/navigation/workbench-project-navigation";
import ProjectFactsStore from "../../workbench/project/ProjectFactsStore";
import WorkbenchThreadClient from "../../workbench/WorkbenchThreadClient";
import type WorkbenchWorkspaceClient from "../../workbench/app/WorkbenchWorkspaceClient";
import ThreadSummaryStore from "../../workbench/thread/ThreadSummaryStore";
import { createThreadSummary } from "workbench-shared/workbench/thread/thread-summary";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
};

const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
  activityAt: 10,
  entryKind: "thread",
  gitArc: {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["app/thread.tsx"],
    intentDescription: "",
    intentName: "repair home state",
    phase: "active",
    proposals: [],
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
  gitArcPlan: {
    checkpointCommit: "b".repeat(40),
    intentDescription: "",
    intentName: "next repair",
    scopePaths: ["app/next.tsx"],
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
  identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
  lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  metadata: { archived: false, pinned: false, snoozed: false },
  title: "Thread",
};
const projectSnapshot = {
  entries: [entry],
  error: null,
  freshness: "fresh" as const,
  projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  revision: 1,
};
const globalStore = {
  getProjectSnapshot: (projectId: string) => projectId === "project" ? projectSnapshot : null,
  getProjectThreadSidebars: () => ({ projects: [projectSnapshot] }),
  getSnapshot: () => null,
  subscribe: () => () => undefined,
} satisfies WorkbenchThreadSidebarStore;
const pending = { getSnapshot: () => ({ phase: "pending" as const, failure: null, value: null }), release: () => {} };
const client = {
  controls: null,
  mounted: {
    networkClient: {} as NonNullable<WorkbenchClientController["mounted"]>["networkClient"],
    files: {} as NonNullable<WorkbenchClientController["mounted"]>["files"],
    presentationClient: {} as NonNullable<WorkbenchClientController["mounted"]>["presentationClient"],
    workspace: {} as NonNullable<WorkbenchClientController["mounted"]>["workspace"],
    voice: { settings: { subscribe: () => () => {}, enabled: false } } as unknown as NonNullable<WorkbenchClientController["mounted"]>["voice"],
    projectFileIndexStore: {} as NonNullable<WorkbenchClientController["mounted"]>["projectFileIndexStore"],
    projectFacts: new ProjectFactsStore({ observe: () => pending }, () => {}),
    getThreadStore: (projectId, target) => new ThreadStore(projectId, target, () => ({
      feed: "observed", actions: {} as ThreadStoreActions, acquire: () => () => {}, recover: async () => {}, dispose: () => {},
    })),
    threadOwnerFor: () => null,
    locationOwnerFor: location => ({ ...location, hostname: "local", rootPath: "/repo", displayPath: "repo" }),
    threadDraftIdentityFor: () => null,
    threadContextFor: () => null,
    launchContextFor: () => null,
    draftContextFor: () => null,
    draftLocationFor: () => null,
    selectBrowseLocation: async () => undefined,
    refreshInstallationProjects: async () => { throw new Error("Unused by this test."); },
    navigation: {} as NonNullable<WorkbenchClientController["mounted"]>["navigation"],
    projectNavigator: new WorkbenchProjectNavigation([], []),
    routeIntents: {} as NonNullable<WorkbenchClientController["mounted"]>["routeIntents"],
    controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
    dispose: () => undefined,
    threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
    threadSidebar: globalStore,
    threadTextPresentation: {} as NonNullable<WorkbenchClientController["mounted"]>["threadTextPresentation"],
    threadTextPresentationFor: () => null,
    projectSourceErrors: { getSnapshot: () => "", subscribe: () => () => undefined },
    subscribeChanges: () => () => undefined,
  },
} satisfies WorkbenchClientController;

function ThreadStateProbe({ projectId }: { projectId: string }) {
  const selected = useThread.sidebarEntry(fixtureIdentitySchemas.ProjectIdSchema.parse(projectId), "codex", "thread");
  return (
    <output>
      {selected
        ? `${selected.lifecycle.kind}:${selected.gitArc?.phase}:${selected.gitArcPlan?.scopePaths.join(",")}`
        : "missing"}
    </output>
  );
}

test("thread state hooks resolve the project owner while the route snapshot is null", () => {
  const html = renderToStaticMarkup(createElement(
    WorkbenchClientProvider,
    {
      children: createElement(ThreadStateProbe, { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }),
      client,
    },
  ));
  assert.match(html, /needsAttention:active:app\/next\.tsx/u);
});

test("thread state hooks do not leak another project's entry", () => {
  const html = renderToStaticMarkup(createElement(
    WorkbenchClientProvider,
    {
      children: createElement(ThreadStateProbe, { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other") }),
      client,
    },
  ));
  assert.match(html, />missing</u);
});

test("arc selectors read the owner's source, not a selected sidebar with the same project ID", () => {
  const location = {
    daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
    projectId: projectSnapshot.projectId,
  };
  const blocker = {
    ...entry,
    identity: { ...entry.identity, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("blocker") },
    gitArc: { ...entry.gitArc!, claimedPaths: ["app/next.tsx"] },
  };
  const source = { ...projectSnapshot, entries: [entry, blocker] };
  const store = {
    ...globalStore,
    getLocationSnapshot: (target: typeof location) =>
      target.daemonId === location.daemonId ? source : null,
    getProjectSnapshot: () => ({ ...projectSnapshot, entries: [] }),
  };
  const ownerClient = {
    ...client,
    mounted: { ...client.mounted, threadSidebar: store,
      threadOwnerFor: () => ({ ...location, hostname: "local", rootPath: "/repo", displayPath: "repo" }) },
  } satisfies WorkbenchClientController;
  let result!: {
    intersections: ReturnType<typeof useThread.claimIntersections>;
    collisions: ReturnType<typeof useThread.collisions>;
    arcEntry: ReturnType<typeof useThread.arc>;
  };
  function Probe() {
    result = {
      intersections: useThread.claimIntersections("thread", "codex", "plan"),
      collisions: useThread.collisions("thread", [{ harness: "codex", threadId: "blocker" }]),
      arcEntry: useThread.arc("thread", "codex"),
    };
    return null;
  }
  renderToStaticMarkup(createElement(WorkbenchClientProvider, { client: ownerClient, children: createElement(Probe) }));
  assert.deepEqual(result.intersections.intersections.activeEntries.map(item => item.entry.identity.threadId), ["blocker"]);
  assert.deepEqual(result.collisions.entries.map(item => item.identity.threadId), ["blocker"]);
  assert.equal(result.arcEntry?.identity.threadId, "thread");
});

test("title history actions target their project and preserve rejection", async () => {
  const calls: object[] = [];
  const controls = {
    setThreadTitle: async (request: object) => { calls.push(request); return "old"; },
    updateThreadStateWithAcceptance: async (request: object) => { calls.push(request); return false; },
  } as WorkbenchClientController["controls"];
  let history!: ReturnType<typeof useThread.titleHistory>;
  function Probe() {
    history = useThread.titleHistory(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"));
    return null;
  }
  renderToStaticMarkup(createElement(WorkbenchClientProvider, {
    client: { ...client, controls },
    children: createElement(Probe),
  }));
  await history.reapply("old");
  assert.deepEqual(calls, [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), harness: "codex", threadId: "thread", title: "old" }]);
  await assert.rejects(history.dismiss("old"));
  assert.deepEqual(calls[1], {
    method: "workbench/thread-state/title/dismiss",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    identity: { harness: "codex", threadId: "thread" },
    title: "old",
  });
  renderToStaticMarkup(createElement(WorkbenchClientProvider, { client, children: createElement(Probe) }));
  await assert.rejects(history.reapply("old"));
  await assert.rejects(history.dismiss("old"));
});

test("title-history previews cannot poison parent and sibling navigation, even before summaries arrive", async t => {
  for (const pending of [false, true]) await t.test(pending ? "summary initially pending" : "summary already available", async () => {
    const projectId = fixtureIdentitySchemas.ProjectIdSchema.parse("project");
    const parentId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent");
    const parent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
      activityAt: 1, entryKind: "thread", title: "Parent", identity: { harness: "codex", threadId: parentId },
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    };
    const children = ["first", "second"].map((id, directSubagentIndex): Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> => ({
      activityAt: 1, entryKind: "subagent", title: id,
      identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id) },
      createdAt: 1, updatedAt: 1, cwd: "C:/repo", directSubagentIndex, name: id,
      parentThreadId: parentId, pinned: false, profileId: "worker", profileName: "Worker", projectId,
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    }));
    const family = [parent, ...children];
    const workspace = {
      rpc: { onReconnect: () => () => {} },
      onDisconnect: () => () => {},
      onWorkbenchNotification: () => () => {},
      onThreadEvent: () => () => {},
      observeThread: async (request: Parameters<WorkbenchWorkspaceClient["observeThread"]>[0]) => {
        const root = request.target.kind === "subagent" ? request.target.parentThreadId : request.target.threadId;
        return { observation: { ...request, entries: root === parentId ? family : [],
          error: null, freshness: "fresh", revision: 1, version: 2, updateKind: "threadObservation" } };
      },
      releaseThread: async () => {},
    } as unknown as WorkbenchWorkspaceClient;
    const renderer = WorkbenchThreadClient({ workspace });
    const summaries = new ThreadSummaryStore({ observe: () => { throw new Error("Static rendering does not subscribe."); } });
    let available = !pending;
    t.mock.method(summaries, "get", (id: string) => {
      const entry = available ? family.find(entry => entry.identity.threadId === id) : null;
      return entry ? {
        location: { daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111"), projectId },
        logicalProjectId: null, summary: createThreadSummary(entry, {}),
      } : null;
    });
    const previewClient = {
      ...client, mounted: { ...client.mounted, getThreadStore: renderer.getThreadStore, threadSummaries: summaries },
    };
    function Preview({ threadId }: { threadId: typeof parentId }) {
      useThread.titleHistory(projectId, "codex", threadId);
      return null;
    }
    const preview = (threadId: typeof parentId) => renderToStaticMarkup(createElement(WorkbenchClientProvider, {
      client: previewClient, children: createElement(Preview, { threadId }),
    }));
    const project = { id: projectId, name: "repo", rootPath: "C:/repo", roots: [] };
    let release = () => {};
    try {
      assert.deepEqual(await renderer.openThread(parentId, { project, harness: "codex" }), { kind: "opened" });
      for (const entry of family) preview(entry.identity.threadId);
      available = true;
      for (const selected of [parent, children[0]!, parent, children[1]!, children[0]!, children[0]!, parent]) {
        preview(selected.identity.threadId);
        release();
        const target = selected.entryKind === "subagent"
          ? { kind: "subagent" as const, parentThreadId: parentId, ...selected.identity }
          : { kind: "provider" as const, ...selected.identity };
        const store = renderer.getThreadStore(projectId, target);
        release = store.acquire("summary");
        await Promise.resolve();
        assert.equal(store.getSlice("summary").error, null);
        assert.equal(store.getSlice("summary").status, "ready");
        assert.equal(store.getSlice("summary").head?.id, selected.identity.threadId);
      }
    } finally {
      release();
      summaries.dispose();
      renderer.dispose();
    }
  });
});
