/*
 * No production exports. Tests protect compact plan reuse plus mounted preview and unmounted live ownership in sidebar tooltip details. Keywords: sidebar, tooltip, plan, questionnaire, proposal, ownership.
 */
import assert from "node:assert/strict";
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

function renderDetails(
  materialized: boolean,
  cwd: string | null = "C:/workspace",
  canRead = true,
  options: {
    pendingRequest?: WorkbenchPendingUserInputRequest | null;
    proposalId?: string | null;
    sidebarStore?: WorkbenchThreadSidebarStore | null;
  } = {},
) {
  return renderWithClient(
    createElement(WorkbenchThreadTooltipDetails, {
      cwd,
      harness: "codex",
      materialized,
      onDraftChange: () => undefined,
      onDraftClear: () => undefined,
      onOpenThread: () => undefined,
      onReadThread: canRead ? async () => null : null,
      onSubmitUserInputRequest: async () => undefined,
      pendingRequest: options.pendingRequest === undefined ? pendingRequest : options.pendingRequest,
      projectId: "project",
      proposalId: options.proposalId === undefined ? "proposal" : options.proposalId,
      questionnaireDraft: null,
      spellCheck: true,
      threadId: "thread",
    }),
    options.sidebarStore ?? null,
  );
}

function createClient(store: WorkbenchThreadSidebarStore | null): WorkbenchClientController {
  return {
    controls: null,
    explorer: {} as WorkbenchClientController["explorer"],
    mounted: store ? {
      controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
      dispose: () => undefined,
      threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
      threadSidebar: store,
      threadTextPresentation: {} as NonNullable<WorkbenchClientController["mounted"]>["threadTextPresentation"],
    } : null,
    transcriptSource: { status: "idle" },
  };
}

function renderWithClient(content: ReactNode, store: WorkbenchThreadSidebarStore | null) {
  return renderToStaticMarkup(createElement(
    WorkbenchClientProvider,
    {
      children: createElement(WorkbenchContextMenuProvider, null, content),
      client: createClient(store),
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
    identity: { harness: "codex", threadId },
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
  claimedPaths: ["src/feature/card.tsx"],
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
    projectId: "project",
    revision: 1,
};
const planStore = {
  getProjectSnapshot: (projectId: string) => projectId === "project" ? planSnapshot : null,
  getProjectThreadSidebars: () => ({ projects: [planSnapshot] }),
  getSnapshot: () => null,
  subscribe: () => () => undefined,
} satisfies WorkbenchThreadSidebarStore;

test("materialized thread roots render questionnaire and proposal previews", () => {
  const html = renderDetails(true);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.match(html, /data-thread-tooltip-proposal="preview"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit|data-thread-checkpoint-commit-action/u);
});

test("unmounted thread roots render the real compact questionnaire and proposal actions", () => {
  const html = renderDetails(false);
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
  assert.match(html, /data-thread-checkpoint-commit-action="true"/u);
});

test("proposals without cwd remain preview-only", () => {
  const html = renderDetails(false, null);
  assert.match(html, /data-thread-tooltip-proposal="preview"/u);
  assert.doesNotMatch(html, /data-thread-checkpoint-commit-action/u);
});

test("questionnaires remain preview-only while thread controls are unavailable", () => {
  const html = renderDetails(false, "C:/workspace", false);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit/u);
});

test("planned-work tooltips keep active intersection navigation and omit planned intersections", () => {
  const compactHtml = renderDetails(false, "C:/workspace", true, {
    pendingRequest: null,
    proposalId: null,
    sidebarStore: planStore,
  });
  assert.match(compactHtml, /href="\/project\/@\/thread\/active%20intersection"/u);
  assert.doesNotMatch(compactHtml, /href="\/project\/@\/thread\/planned%20intersection"|<details/u);

  const fullHtml = renderWithClient(
    createElement(ThreadGitArcIntersectionCard, {
      harness: "codex",
      onOpenThread: () => undefined,
      projectId: "project",
      threadId: "thread",
    }),
    planStore,
  );
  assert.match(fullHtml, /<details/u);
});

test("Git arc waits show active claim owners without planned-only intersections", () => {
  const html = renderWithClient(
    createElement(ThreadGitArcIntersectionCard, {
      harness: "codex",
      mode: "wait",
      onOpenThread: () => undefined,
      projectId: "project",
      threadId: "thread",
    }),
    planStore,
  );

  assert.match(html, /data-thread-git-arc-intersection-card="wait"/u);
  assert.match(html, /href="\/project\/@\/thread\/active%20intersection"/u);
  assert.doesNotMatch(html, /planned%20intersection|<details/u);
});
