/*
 * No production exports. Tests protect project-qualified thread state in project and global observation modes. Keywords: hooks, home, sidebar, lifecycle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import type { WorkbenchClientController } from "./workbench-client-context";
import { useWorkbenchThreadSidebarEntry } from "./use-workbench-client";

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
  identity: { harness: "codex", threadId: "thread" },
  lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  metadata: { archived: false, pinned: false, snoozed: false },
  title: "Thread",
};
const projectSnapshot = {
  entries: [entry],
  error: null,
  freshness: "fresh" as const,
  projectId: "project",
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
    controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
    dispose: () => undefined,
    threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
    threadSidebar: globalStore,
  },
  transcriptComparison: { available: false, projection: null },
} satisfies WorkbenchClientController;

function ThreadStateProbe({ projectId }: { projectId: string }) {
  const selected = useWorkbenchThreadSidebarEntry(projectId, "codex", "thread");
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
      children: createElement(ThreadStateProbe, { projectId: "project" }),
      client,
    },
  ));
  assert.match(html, /needsAttention:active:next repair/u);
});

test("thread state hooks do not leak another project's entry", () => {
  const html = renderToStaticMarkup(createElement(
    WorkbenchClientProvider,
    {
      children: createElement(ThreadStateProbe, { projectId: "other" }),
      client,
    },
  ));
  assert.match(html, />missing</u);
});
