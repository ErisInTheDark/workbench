/* No production exports. Protect addressed feedback lifecycle visibility and planned-claim intersection status states. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import type {
  WorkbenchThreadLifecycle, WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientContext from "../workbench-client-context";
import type { WorkbenchClientController } from "../workbench-client-context";
import type { ThreadLiveActivityView } from "./use-thread-live-activity";
import ThreadStatusArea from "./ThreadStatusArea";

const feedback = [{
  kind: "feedback" as const,
  id: 7,
  daemonId: "daemon-a",
  category: "bug" as const,
  title: "Stats action fails",
  author: "model",
  thread: "source thread",
  createdAt: 1,
  report: "The stats action fails.",
}];

function render(lifecycle: WorkbenchThreadLifecycle) {
  return renderToStaticMarkup(createElement(WorkbenchClientContext.Provider, {
    value: { controls: null, mounted: null },
  }, createElement(ThreadStatusArea, {
    addressedFeedback: feedback,
    gitArc: null,
    harness: "codex",
    live: null,
    onFeedbackDeleted: async () => {},
    onOpenThread: () => {},
    skills: null,
    threadId: "thread",
    threadLifecycle: lifecycle,
    todos: { count: 0, goalSet: false, renderPanel: () => null },
    vis: null,
  })));
}

test("working and completed threads both expose their addressed feedback count", () => {
  const working = render({
    agent: { agentStatus: "working" },
    kind: "working",
    reason: "acceptedIntent",
    settled: false,
  });
  const completed = render({ kind: "completed", reason: "providerInactive", settled: false });
  assert.match(working, />1<\/span>/u);
  assert.match(completed, />1<\/span>/u);
});

type ThreadEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;

const projectId = fixtureIdentitySchemas.ProjectIdSchema.parse("project");
const ownerLocation = {
  daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
  projectId,
};

function planThread(threadId: string, gitArc: ThreadEntry["gitArc"], gitArcPlan: ThreadEntry["gitArcPlan"]): ThreadEntry {
  return {
    activityAt: 10,
    entryKind: "thread",
    gitArc,
    gitArcPlan,
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "questionnaire:plan", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: threadId,
  };
}

const planOwner = planThread("thread", null, {
  checkpointCommit: "a".repeat(40),
  intentDescription: "",
  intentName: "questionnaire plan",
  scopePaths: ["app/feature"],
  updatedAt: "2026-10-13T00:00:00.000Z",
});
const activeOwner = planThread("active owner", {
  checkpointCommit: "b".repeat(40),
  claimedPaths: ["app/feature/card.tsx"],
  intentDescription: "",
  intentName: "active work",
  phase: "active",
  proposals: [],
  updatedAt: "2026-10-13T00:00:00.000Z",
}, null);

function renderPlanStatus(active: boolean, live: ThreadLiveActivityView | null = null) {
  const snapshot = {
    entries: active ? [planOwner, activeOwner] : [planOwner],
    error: null,
    freshness: "fresh" as const,
    projectId,
    revision: 1,
  };
  const sidebar = {
    getLocationSnapshot: () => snapshot,
    getProjectSnapshot: () => snapshot,
    getProjectThreadSidebars: () => ({ projects: [snapshot] }),
    getSnapshot: () => null,
    subscribe: () => () => undefined,
  } satisfies WorkbenchThreadSidebarStore;
  const client = {
    controls: null,
    mounted: {
      threadOwnerFor: () => ({
        ...ownerLocation,
        displayPath: "project",
        hostname: "local",
        rootPath: "C:/workspace",
      }),
      threadSidebar: sidebar,
    },
  } as unknown as WorkbenchClientController;
  return renderToStaticMarkup(createElement(WorkbenchClientContext.Provider, {
    value: client,
  }, createElement(ThreadStatusArea, {
    gitArc: null,
    harness: "codex",
    live,
    onFeedbackDeleted: async () => {},
    onOpenThread: () => {},
    skills: null,
    threadId: "thread",
    threadLifecycle: planOwner.lifecycle,
    todos: null,
    vis: null,
  })));
}

test("planned scope status distinguishes active intersections from clear scope and yields to live activity", () => {
  const active = renderPlanStatus(true);
  assert.match(active, /data-thread-plan-intersection-status="active"/u);
  assert.match(active, /aria-haspopup="dialog"/u);

  const clear = renderPlanStatus(false);
  assert.match(clear, /data-thread-plan-intersection-status="clear"/u);
  assert.match(clear, /aria-haspopup="dialog"/u);

  const live = renderPlanStatus(false, { key: "turn", title: "Working", renderBody: () => null });
  assert.doesNotMatch(live, /data-thread-plan-intersection-status=/u);
});
