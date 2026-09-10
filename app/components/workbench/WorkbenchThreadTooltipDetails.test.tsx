/*
 * No production exports. Tests protect compact plan reuse plus mounted preview and unmounted live ownership in sidebar tooltip details.
 */
import assert from "node:assert/strict";
import ThreadObservationController, { getThreadObservationKey } from "../../workbench/thread/ThreadObservationController";
import WorkbenchThreadRuntimeStore from "../../workbench/WorkbenchThreadRuntimeStore";
import WorkbenchThreadController from "../../workbench/WorkbenchThreadController";
import { test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchPendingUserInputRequest, WorkbenchThreadSidebarStore } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import type { WorkbenchClientController } from "./workbench-client-context";
import WorkbenchContextMenuProvider from "./WorkbenchContextMenuProvider";
import WorkbenchThreadTooltipDetails from "./WorkbenchThreadTooltipDetails";
import ThreadGitArcIntersectionCard from "./thread-view/ThreadGitArcIntersectionCard";
import ThreadGitArcConflictList from "./thread-view/ThreadGitArcConflictList";
import { getWorkbenchThreadPlanIntersections } from "workbench-shared/workbench/thread/thread-state";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
};

const pendingRequest = {
  harness: "codex",
  itemId: "item",
  request: {
    id: "questionnaire",
    questions: [{
      allowOther: false,
      header: "Choice",
      id: "choice",
      isSecret: false,
      options: [
        { description: "Keep one owner.", label: "Shared" },
        { description: "Create a drifting clone.", label: "Clone" },
      ],
      question: "Choose a component.",
    }],
    submitLabel: "Send answer",
    summary: "",
    title: "Ownership",
  },
  requestKey: "questionnaire:one",
  threadId: "thread",
  turnId: "turn",
} satisfies WorkbenchPendingUserInputRequest;

async function renderDetails(
  materialized: boolean,
  cwd: string | null = "C:/workspace",
  canRead = true,
  options: {
    pendingRequest?: WorkbenchPendingUserInputRequest | null;
    proposalId?: string | null;
    sidebarStore?: WorkbenchThreadSidebarStore | null;
    disconnected?: boolean;
  } = {},
) {
  const request = options.pendingRequest === undefined ? pendingRequest : options.pendingRequest;
  const proposalId = options.proposalId === undefined ? "proposal" : options.proposalId;
  const observedEntry = planThread("thread", proposalId ? {
    checkpointCommit: "a".repeat(40), claimedPaths: ["src/feature"], intentDescription: "", intentName: "test",
    phase: "active", proposals: [{ proposalId, status: "proposed" }], updatedAt: "2026-09-10",
  } : null);
  const owner = new ThreadObservationController({ request: async (method, params) => method.endsWith("/release") ? {} : {
    observation: { ...params, entries: [observedEntry], error: null, freshness: "fresh", revision: 1, updateKind: "threadObservation" },
  } });
  let ready!: () => void;
  const loaded = new Promise<void>(resolve => { ready = resolve; });
  const key = getThreadObservationKey("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] });
  const consumer = owner.acquire("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, () => {
    if (["ready", "failed"].includes(owner.getSnapshot(key).status)) ready();
  });
  await loaded;
  assert.equal(owner.getSnapshot(key).status, "ready");
  if (options.disconnected) owner.disconnect();
  const client = createClient(options.sidebarStore ?? null);
  client.controls = canRead ? {} as NonNullable<WorkbenchClientController["controls"]> : null;
  client.mounted!.threadRuntime = WorkbenchThreadRuntimeStore({
    currentThread: null, currentThreadId: "", isLoading: false,
    pendingUserInputRequestsByThreadId: request ? { thread: request } : {},
    rateLimits: null, subagents: [], threadDocuments: { documentsByKey: {}, keysByThreadId: {}, selectedThreadKey: "" }, threads: [], threadsError: "",
  });
  const thread = new WorkbenchThreadController("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, {
    observations: owner,
    getChild: () => { throw new Error("Unexpected child."); },
    controls: {} as NonNullable<WorkbenchClientController["controls"]>,
    readNative: () => ({ document: null, pendingQuestionnaire: request, rateLimits: null }),
    subscribeNative: client.mounted!.threadRuntime.subscribe,
    read: async () => { throw new Error("Tooltip rendering must not load the transcript."); },
    createTranscript: () => { throw new Error("Tooltip rendering must not subscribe to SQLite."); },
    reportError: message => { throw new Error(message); },
  });
  const releaseThread = thread.acquire("summary");
  client.mounted!.getThreadController = () => thread;
  const html = renderWithClient(
    createElement(WorkbenchThreadTooltipDetails, {
      cwd,
      harness: "codex",
      materialized,
      onOpenThread: () => undefined,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      spellCheck: true,
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    }),
    options.sidebarStore ?? null,
    client,
  );
  consumer.release();
  releaseThread();
  thread.dispose();
  owner.dispose();
  return html;
}

function createClient(store: WorkbenchThreadSidebarStore | null): WorkbenchClientController {
  return {
    controls: null,
    explorer: {} as WorkbenchClientController["explorer"],
    mounted: {
      getThreadController: () => { throw new Error("Unexpected thread view during static rendering."); },
      controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
      dispose: () => undefined,
      threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
      threadSidebar: store ?? planStore,
      threadTextPresentation: {} as NonNullable<WorkbenchClientController["mounted"]>["threadTextPresentation"],
    },
  };
}

function renderWithClient(content: ReactNode, store: WorkbenchThreadSidebarStore | null, client = createClient(store)) {
  return renderToStaticMarkup(createElement(
    WorkbenchClientProvider,
    {
      children: createElement(WorkbenchContextMenuProvider, null, content),
      client,
    },
  ));
}

function planThread(
  threadId: string,
  gitArc: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["gitArc"] = null,
  gitArcPlan: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["gitArcPlan"] = null,
): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> {
  return {
    activityAt: 10,
    entryKind: "thread",
    gitArc,
    gitArcPlan,
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: threadId,
  };
}

const planOwner = planThread("thread", null, {
  checkpointCommit: "a".repeat(40),
  intentDescription: "",
  intentName: "tooltip plan",
  scopePaths: ["src/feature"],
  updatedAt: "2026-08-27T00:00:00.000Z",
});
const activeIntersection = planThread("active intersection", {
  checkpointCommit: "b".repeat(40),
  claimedPaths: ["src/feature/card.tsx", "docs/unrelated.ts"],
  intentDescription: "",
  intentName: "active work",
  phase: "active",
  proposals: [],
  updatedAt: "2026-08-27T00:00:00.000Z",
});
const plannedIntersection = planThread("planned intersection", null, {
  checkpointCommit: "c".repeat(40),
  intentDescription: "",
  intentName: "other plan",
  scopePaths: ["src/feature/other.ts"],
  updatedAt: "2026-08-27T00:00:00.000Z",
});
const planSnapshot = {
    entries: [planOwner, activeIntersection, plannedIntersection],
    error: null,
    freshness: "fresh" as const,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    revision: 1,
};
const planStore = {
  getProjectSnapshot: (projectId: string) => projectId === "project" ? planSnapshot : null,
  getProjectThreadSidebars: () => ({ projects: [planSnapshot] }),
  getSnapshot: () => null,
  subscribe: () => () => undefined,
} satisfies WorkbenchThreadSidebarStore;

test("materialized thread roots render questionnaire and proposal previews", async () => {
  const html = await renderDetails(true);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.match(html, /data-thread-tooltip-proposal="preview"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit|data-thread-checkpoint-commit-action/u);
});

test("unmounted thread roots render the real compact questionnaire and proposal actions", async () => {
  const html = await renderDetails(false);
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
  assert.match(html, /data-thread-checkpoint-commit-action="true"/u);
});

test("proposals without cwd remain preview-only", async () => {
  const html = await renderDetails(false, null);
  assert.match(html, /data-thread-tooltip-proposal="preview"/u);
  assert.doesNotMatch(html, /data-thread-checkpoint-commit-action/u);
});

test("reconnecting preserves the admitted questionnaire presentation", async () => {
  const html = await renderDetails(false, "C:/workspace", true, { disconnected: true });
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
});

test("planned-work tooltips keep active intersection navigation and omit planned intersections", async () => {
  const compactHtml = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null,
    proposalId: null,
    sidebarStore: planStore,
  });
  assert.match(compactHtml, /href="\/project\/@\/thread\/active%20intersection"/u);
  assert.match(compactHtml, /data-project-file-project-id="project"[^>]*data-project-file-relative-path="src\/feature\/card.tsx"/u);
  assert.doesNotMatch(compactHtml, /data-project-file-relative-path="docs\/unrelated.ts"/u);
  assert.doesNotMatch(compactHtml, /href="\/project\/@\/thread\/planned%20intersection"|<details/u);

  const fullHtml = renderWithClient(
    createElement(ThreadGitArcIntersectionCard, {
      harness: "codex",
      onOpenThread: () => undefined,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      threadId: "thread",
    }),
    planStore,
  );
  assert.match(fullHtml, /<details/u);
  const plannedHtml = renderWithClient(createElement(ThreadGitArcConflictList, {
    entries: getWorkbenchThreadPlanIntersections(planSnapshot.entries, planOwner.identity).plannedEntries,
    onOpenThread: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  }), planStore);
  assert.match(plannedHtml, /data-project-file-relative-path="src\/feature\/other.ts"/u);
});

test("Git arc waits show active claim owners without planned-only intersections", () => {
  const html = renderWithClient(
    createElement(ThreadGitArcIntersectionCard, {
      harness: "codex",
      mode: "wait",
      onOpenThread: () => undefined,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      threadId: "thread",
    }),
    planStore,
  );

  assert.match(html, /data-thread-git-arc-intersection-card="wait"/u);
  assert.match(html, /data-project-file-relative-path="src\/feature\/card.tsx"/u);
  assert.doesNotMatch(html, /data-project-file-relative-path="(?:docs\/unrelated.ts|src\/feature\/other.ts)"/u);
  assert.match(html, /href="\/project\/@\/thread\/active%20intersection"/u);
  assert.doesNotMatch(html, /planned%20intersection|<details/u);
});
