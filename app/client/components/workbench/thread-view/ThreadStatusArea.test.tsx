/* No production exports. Protect addressed feedback lifecycle visibility, planned-claim intersection status states and idle auto-open priority. */
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
import ThreadStatusArea, { getThreadStatusAttention } from "./ThreadStatusArea";

function render(lifecycle: WorkbenchThreadLifecycle) {
  return renderToStaticMarkup(createElement(WorkbenchClientContext.Provider, {
    value: { controls: null, mounted: null },
  }, createElement(ThreadStatusArea, {
    gitArc: null,
    harness: "codex",
    live: null,
    skills: null,
    threadId: "thread",
    threadLifecycle: lifecycle,
    todos: { count: 0, feedbackCount: 1, goalSet: false, renderPanel: () => null },
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

test("idle auto-open prefers proposals, then required todos or feedback, then dirty claims", () => {
  const idle: Parameters<typeof getThreadStatusAttention>[0] = {
    dirtyClaimedPaths: null, feedbackCount: 0, pendingProposalIds: [], requiredTodoCount: 0,
  };
  const panel = (work: Partial<typeof idle>) => getThreadStatusAttention({ ...idle, ...work })?.panel ?? null;

  assert.equal(panel({}), null);
  assert.equal(panel({ dirtyClaimedPaths: ["a.ts"] }), "arc");
  assert.equal(panel({ dirtyClaimedPaths: ["a.ts"], feedbackCount: 1 }), "todos");
  assert.equal(panel({ dirtyClaimedPaths: ["a.ts"], requiredTodoCount: 1 }), "todos");
  assert.equal(panel({ pendingProposalIds: ["p"], requiredTodoCount: 1, feedbackCount: 1, dirtyClaimedPaths: ["a.ts"] }), "arc");
  // Falling from proposals to dirty claims keeps the arc panel but is new work, so it gets a new key.
  assert.notEqual(
    getThreadStatusAttention({ ...idle, pendingProposalIds: ["p"], dirtyClaimedPaths: ["a.ts"] })?.key,
    getThreadStatusAttention({ ...idle, dirtyClaimedPaths: ["a.ts"] })?.key,
  );
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
