/*
 * No production exports. Tests protect project-qualified thread state in project and global observation modes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import ThreadObservationController from "../../workbench/thread/ThreadObservationController";
import type { WorkbenchClientController } from "./workbench-client-context";
import { useWorkbenchThreadSidebarEntry, useWorkbenchThreadTitleHistory } from "./use-workbench-client";
import WorkbenchThreadController from "../../workbench/WorkbenchThreadController";
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
const client = {
  controls: null,
  explorer: {} as WorkbenchClientController["explorer"],
  mounted: {
    getThreadController: (projectId, target) => new WorkbenchThreadController(projectId, target, {
      getChild: () => { throw new Error("Unexpected child."); },
      observations: new ThreadObservationController({ request: async () => { throw new Error("Unexpected observation during static rendering."); } }),
      controls: {} as NonNullable<WorkbenchClientController["controls"]>,
      readNative: () => ({ document: null, pendingQuestionnaire: null, rateLimits: null }),
      subscribeNative: () => () => {},
      read: async () => null,
      createTranscript: () => { throw new Error("Unexpected transcript during static rendering."); },
      reportError: message => { throw new Error(message); },
    }),
    controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
    dispose: () => undefined,
    threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
    threadSidebar: globalStore,
    threadTextPresentation: {} as NonNullable<WorkbenchClientController["mounted"]>["threadTextPresentation"],
  },
} satisfies WorkbenchClientController;

function ThreadStateProbe({ projectId }: { projectId: string }) {
  const selected = useWorkbenchThreadSidebarEntry(fixtureIdentitySchemas.ProjectIdSchema.parse(projectId), "codex", "thread");
  return (
    <output>
      {selected
        ? `${selected.lifecycle.kind}:${selected.gitArc?.phase}:${selected.gitArcPlan?.intentName}`
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
  assert.match(html, /needsAttention:active:next repair/u);
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

test("title history actions target their project and preserve rejection", async () => {
  const calls: object[] = [];
  const controls = {
    setThreadTitle: async (request: object) => { calls.push(request); return "old"; },
    updateThreadStateWithAcceptance: async (request: object) => { calls.push(request); return false; },
  } as WorkbenchClientController["controls"];
  let history!: ReturnType<typeof useWorkbenchThreadTitleHistory>;
  function Probe() {
    history = useWorkbenchThreadTitleHistory(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"));
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
