/*
 * Exports:
 * - No production exports; rendering tests protect tooltip plan reuse, preview ownership, live sidebar state, section urgency order, todos and waits.
 */
import assert from "node:assert/strict";
import ThreadObservationController, { getThreadObservationKey } from "../../workbench/thread/ThreadObservationController";
import WorkbenchThreadRuntimeStore from "../../workbench/WorkbenchThreadRuntimeStore";
import ThreadStore, { EMPTY_THREAD_STORE_STATE, type ThreadHead, type ThreadStoreActions } from "../../workbench/thread/ThreadStore";
import { test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchPendingUserInputRequest, WorkbenchThreadSidebarStore } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type {
  WorkbenchGitArcProposalSummary, WorkbenchPinnedThreadSummaryEntry, WorkbenchThreadSidebarEntry, WorkbenchThreadWaitTarget,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import WorkbenchClientProvider from "./WorkbenchClientProvider";
import type { WorkbenchClientController } from "./workbench-client-context";
import ProjectFactsStore from "../../workbench/project/ProjectFactsStore";
import WorkbenchProjectNavigation from "../../workbench/navigation/workbench-project-navigation";
import WorkbenchContextMenuProvider from "./WorkbenchContextMenuProvider";
import WorkbenchThreadTooltipDetails from "./WorkbenchThreadTooltipDetails";
import { ObservedThreadGitArcIntersectionCard } from "./thread-view/ThreadGitArcIntersectionCard";
import WorkbenchThreadReferenceList from "./WorkbenchThreadReferenceList";
import { getWorkbenchThreadClaimIntersections } from "workbench-shared/workbench/thread/thread-state";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const pendingFacts = { getSnapshot: () => ({ phase: "pending" as const, failure: null, value: null }), release: () => {} };
const fixtureIdentityValues = {
  WorkbenchThreadId: {
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
};
const defaultOwnerLocation = {
  daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
  projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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

const threadHead: ThreadHead = {
  agentNickname: null, agentPath: null, agentRole: null, cwd: "C:/workspace", harness: "codex",
  id: fixtureIdentityValues.WorkbenchThreadId["thread"], isDraft: false, model: null, name: null,
  reasoningEffort: null, serviceTier: null, status: "idle", tokenUsage: null,
};

async function renderDetails(
  materialized: boolean,
  cwd: string | null = "C:/workspace",
  canRead = true,
  options: {
    pendingRequest?: WorkbenchPendingUserInputRequest | null;
    proposalId?: string | null;
    sidebarStore?: WorkbenchThreadSidebarStore | null;
    disconnected?: boolean;
    observationPending?: boolean;
    ownerLocation?: ProjectLocationReference;
    todos?: WorkbenchThreadTodo[];
    waitingOnThreads?: WorkbenchThreadWaitTarget[];
    proposalSummary?: WorkbenchGitArcProposalSummary;
    /** Replaces the lone fixture proposal with a stack: its layers and every pending proposal. */
    stack?: { proposalIds: string[]; stackLayers: Array<{ layerId: string; proposalIds: string[]; sealedAt: string; title: string }> };
  } = {},
) {
  const request = options.pendingRequest === undefined ? pendingRequest : options.pendingRequest;
  const proposalId = options.proposalId === undefined ? "proposal" : options.proposalId;
  const observedEntry = {
    ...planThread("thread", proposalId ? {
      checkpointCommit: "a".repeat(40), claimedPaths: ["src/feature"], intentDescription: "", intentName: "test",
      phase: "active", updatedAt: "2026-09-10",
      proposals: options.stack
        ? options.stack.proposalIds.map(id => ({ proposalId: id, status: "proposed" as const }))
        : [{ proposalId, status: "proposed", ...(options.proposalSummary ? { summary: options.proposalSummary } : {}) }],
      ...(options.stack ? { stackLayers: options.stack.stackLayers } : {}),
    } : null),
    ...(options.waitingOnThreads ? { waitingOnThreads: options.waitingOnThreads } : {}),
  };
  let admit!: () => void;
  const admission = new Promise<void>(resolve => { admit = resolve; });
  if (!options.observationPending) admit();
  const owner = new ThreadObservationController({ observe: async params => {
    await admission;
    return { observation: { ...params, entries: [observedEntry], error: null, freshness: options.disconnected ? "loading" : "fresh",
      revision: 1, version: 2, updateKind: "threadObservation" } };
  }, release: async () => {} });
  let ready!: () => void;
  const loaded = new Promise<void>(resolve => { ready = resolve; });
  const key = getThreadObservationKey("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] });
  const consumer = owner.acquire("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, () => {
    if (owner.getSnapshot(key).observation || owner.getSnapshot(key).status === "failed") ready();
  });
  if (!options.observationPending) {
    await loaded;
    assert.equal(owner.getSnapshot(key).status, options.disconnected ? "loading" : "ready");
  }
  const client = createClient(options.sidebarStore ?? null, options.ownerLocation);
  client.controls = canRead ? {} as NonNullable<WorkbenchClientController["controls"]> : null;
  client.mounted!.threadRuntime = WorkbenchThreadRuntimeStore({
    currentThread: null, currentThreadId: "", subagents: [], threadDocuments: { documentsByKey: {}, keysByThreadId: {}, selectedThreadKey: "" }, threads: [], threadsError: "",
  });
  // The tooltip reads the thread store's summary and questionnaire; mirror the fixture observation into them.
  const store = new ThreadStore("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, publish => {
    const sync = () => {
      const observed = owner.getSnapshot(key);
      const entry = observed.observation?.entries.find(candidate => candidate.entryKind !== "draft" && candidate.identity.threadId === "thread");
      publish({
        summary: {
          ...EMPTY_THREAD_STORE_STATE.summary,
          status: observed.status === "failed" ? "failed" : entry ? "ready" : "loading", error: observed.error,
          entry: entry && entry.entryKind !== "draft" ? entry : null,
          // The thread's own head carries its cwd; a thread whose head has not loaded has none.
          head: cwd || options.todos ? { ...threadHead, cwd: cwd ?? "", todos: options.todos ?? [] } : null,
        },
        questionnaire: { pending: request },
      });
    };
    const stop = owner.subscribe(sync);
    sync();
    return { feed: "observed", actions: {} as ThreadStoreActions, acquire: () => () => {}, recover: async () => {}, dispose: stop };
  });
  if (options.observationPending) assert.equal(store.getSlice("summary").status, "loading");
  client.mounted!.getThreadStore = () => store;
  const html = renderWithClient(
    createElement(WorkbenchThreadTooltipDetails, {
      harness: "codex",
      materialized,
      fallbackProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      spellCheck: true,
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    }),
    options.sidebarStore ?? null,
    client,
  );
  admit();
  await loaded;
  consumer.release();
  store.dispose();
  owner.dispose();
  return html;
}

function createClient(store: WorkbenchThreadSidebarStore | null, ownerLocation?: ProjectLocationReference): WorkbenchClientController {
  const sourceStore: WorkbenchThreadSidebarStore = store ?? planStore;
  const source = ownerLocation ?? defaultOwnerLocation;
  return {
    controls: null,
    mounted: {
      networkClient: {} as NonNullable<WorkbenchClientController["mounted"]>["networkClient"],
      files: {} as NonNullable<WorkbenchClientController["mounted"]>["files"],
      presentationClient: {} as NonNullable<WorkbenchClientController["mounted"]>["presentationClient"],
      workspace: {} as NonNullable<WorkbenchClientController["mounted"]>["workspace"],
      voice: { settings: { subscribe: () => () => {}, enabled: false } } as unknown as NonNullable<WorkbenchClientController["mounted"]>["voice"],
      projectFileIndexStore: {
        getSnapshot: () => ({ candidates: [], paths: [], id: "project-files:fixture", status: "ready" }),
        subscribe: () => () => undefined,
      } as unknown as NonNullable<WorkbenchClientController["mounted"]>["projectFileIndexStore"],
      projectFacts: new ProjectFactsStore({ observe: () => pendingFacts }, () => {}),
      getThreadStore: () => { throw new Error("Unexpected thread view during static rendering."); },
      threadOwnerFor: () => ({
        ...source, hostname: "local", rootPath: "/project", displayPath: "project",
      }),
      threadDraftIdentityFor: () => null,
      threadContextFor: () => null,
      launchContextFor: () => null,
      draftContextFor: () => null,
      draftLocationFor: () => null,
      selectBrowseLocation: async () => undefined,
      refreshInstallationProjects: async () => { throw new Error("Unused by this test."); },
      navigation: {} as NonNullable<WorkbenchClientController["mounted"]>["navigation"],
      projectNavigator: new WorkbenchProjectNavigation([], [], [], () => source),
      routeIntents: {} as NonNullable<WorkbenchClientController["mounted"]>["routeIntents"],
      controls: {} as NonNullable<WorkbenchClientController["mounted"]>["controls"],
      dispose: () => undefined,
      threadRuntime: {} as NonNullable<WorkbenchClientController["mounted"]>["threadRuntime"],
      threadSidebar: {
        ...sourceStore,
        getLocationSnapshot: sourceStore.getLocationSnapshot
          ?? ((location: ProjectLocationReference) => sourceStore.getProjectSnapshot(location.projectId)),
      },
      threadTextPresentation: {} as NonNullable<WorkbenchClientController["mounted"]>["threadTextPresentation"],
      threadTextPresentationFor: () => null,
      projectSourceErrors: { getSnapshot: () => "", subscribe: () => () => undefined },
      subscribeChanges: () => () => undefined,
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

test("materialized thread roots preview the questionnaire but keep the live proposal list", async () => {
  const html = await renderDetails(true);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
});

test("unmounted thread roots render live questionnaire actions while the proposal loads", async () => {
  const html = await renderDetails(false);
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.doesNotMatch(html, /data-thread-checkpoint-commit-action/u);
});

test("proposals wait for the thread's cwd instead of showing a card that cannot load", async () => {
  const html = await renderDetails(false, null);
  assert.doesNotMatch(html, /data-thread-tooltip-proposal|data-thread-checkpoint-card/u);
});

test("reconnecting preserves the admitted questionnaire presentation", async () => {
  const html = await renderDetails(false, "C:/workspace", true, { disconnected: true });
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
});

test("available questionnaire and plan details survive pending thread observation", async () => {
  const html = await renderDetails(false, "C:/workspace", true, {
    observationPending: true,
    proposalId: null,
    sidebarStore: planStore,
  });
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
  assert.match(html, /href="\/@\/thread\/project\/@\/active%20intersection"/u);
});

test("known questionnaire gets its own busy section before the request is admitted", async () => {
  const entry = {
    ...planThread("thread"),
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "questionnaire:one", settled: false },
  } satisfies WorkbenchThreadSidebarEntry;
  const sidebarStore = {
    ...planStore,
    getProjectSnapshot: () => ({ ...planSnapshot, entries: [entry] }),
  };
  const html = await renderDetails(false, "C:/workspace", true, {
    observationPending: true, pendingRequest: null, proposalId: null, sidebarStore,
  });
  assert.match(html, /data-thread-tooltip-questionnaire="loading"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.doesNotMatch(html, /role="textbox"|data-thread-questionnaire-submit|data-thread-tooltip-proposal/u);
});

test("transcript readiness does not hide admitted questionnaire and proposal details", async () => {
  const html = await renderDetails(true, "C:/workspace", true);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
});

test("cold pinned tooltips use project-qualified summary hints for each pending component", async () => {
  const pinned = {
    ...planThread("thread", {
      checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "",
      phase: "active", proposals: [{ proposalId: "pinned-proposal", status: "proposed" }], updatedAt: "2026-09-11",
    }),
    canCompleteQuestionnaire: true,
    metadata: { archived: false, pinned: true, snoozed: false },
    status: "needsAttention",
  } satisfies WorkbenchPinnedThreadSummaryEntry;
  const summary = {
    counts: { completed: 0, needsAttention: 0, needsAttentionActive: 1, proposedCommit: 1, stopped: 0, working: 0 },
    lastThreadUpdateAt: null, pinnedThreads: [pinned],
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), revision: 1, unsettledThreads: [],
  };
  const sidebarStore: WorkbenchThreadSidebarStore = {
    ...planStore,
    getProjectSnapshot: () => null,
    getProjectThreadSummaries: () => ({ projects: [summary] }),
  };
  const html = await renderDetails(false, "C:/workspace", true, {
    observationPending: true, pendingRequest: null, proposalId: null, sidebarStore,
  });
  assert.match(html, /data-thread-tooltip-questionnaire="loading"/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);

  const otherProjectHtml = await renderDetails(false, "C:/workspace", true, {
    observationPending: true, pendingRequest: null, proposalId: null,
    sidebarStore: {
      ...sidebarStore,
      getProjectThreadSummaries: () => ({
        projects: [{ ...summary, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other-project") }],
      }),
    },
  });
  assert.doesNotMatch(otherProjectHtml, /data-thread-tooltip-questionnaire|data-thread-tooltip-proposal|aria-busy="true"/u);
});

test("admitted metadata removes obsolete sidebar questionnaire and proposal hints", async () => {
  const entry = {
    ...planThread("thread", {
      checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "",
      phase: "active", proposals: [{ proposalId: "obsolete", status: "proposed" }], updatedAt: "2026-09-11",
    }),
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "obsolete", settled: false },
  } satisfies WorkbenchThreadSidebarEntry;
  const html = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null, proposalId: null,
    sidebarStore: { ...planStore, getProjectSnapshot: () => ({ ...planSnapshot, entries: [entry] }) },
  });
  assert.doesNotMatch(html, /data-thread-tooltip-questionnaire|data-thread-tooltip-proposal|aria-busy="true"/u);
});

test("planned-work tooltips keep active intersection navigation and omit planned intersections", async () => {
  const compactHtml = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null,
    proposalId: null,
    sidebarStore: planStore,
  });
  assert.match(compactHtml, /href="\/@\/thread\/project\/@\/active%20intersection"/u);
  assert.match(compactHtml, /data-project-file-project-id="project"[^>]*data-project-file-relative-path="src\/feature\/card.tsx"/u);
  assert.doesNotMatch(compactHtml, /data-project-file-relative-path="docs\/unrelated.ts"/u);
  assert.doesNotMatch(compactHtml, /href="\/@\/thread\/project\/@\/planned%20intersection"|<details/u);

  const fullHtml = renderWithClient(
    createElement(ObservedThreadGitArcIntersectionCard, {
      harness: "codex",
      threadId: "thread",
    }),
    planStore,
  );
  assert.match(fullHtml, /<details/u);
  const plannedHtml = renderWithClient(createElement(WorkbenchThreadReferenceList, {
    references: getWorkbenchThreadClaimIntersections(planSnapshot.entries, planOwner.identity, "plan").plannedEntries.map(({ entry, paths }) => ({
      entry, identity: entry.identity, paths, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), title: entry.title,
    })),
  }), planStore);
  assert.match(plannedHtml, /data-project-file-relative-path="src\/feature\/other.ts"/u);
});

test("a tooltip reads planned intersections from its owner's source during a pending question", async () => {
  const location = {
    daemonId: fixtureIdentitySchemas.DaemonIdSchema.parse(crypto.randomUUID()),
    projectId: planSnapshot.projectId,
  };
  const sourceStore = {
    ...planStore,
    getProjectSnapshot: () => null,
    getLocationSnapshot: (target: ProjectLocationReference) =>
      target.daemonId === location.daemonId ? planSnapshot : null,
  };
  const html = await renderDetails(false, "C:/workspace", true, {
    sidebarStore: sourceStore, ownerLocation: location, proposalId: null,
  });
  assert.match(html, /data-thread-git-arc-intersection-card="plan"/u);
  assert.match(html, /data-thread-reference-list="true"/u);
  assert.match(html, /data-thread-tooltip-questionnaire=/u);
});

test("a home-view intersection uses the known owner", () => {
  const html = renderWithClient(createElement(ObservedThreadGitArcIntersectionCard, {
    harness: "codex",
    threadId: "thread",
  }), planStore);
  assert.match(html, /data-workbench-sidebar-thread-link="true"/u);
});

test("waiting references reuse compact rows and keep unloaded targets navigable", () => {
  const html = renderWithClient(createElement(WorkbenchThreadReferenceList, {
    references: [{
      entry: activeIntersection,
      identity: activeIntersection.identity,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      title: "stale title",
    }, {
      identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing wait") },
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"),
      title: "Missing wait",
    }],
  }), planStore);
  assert.match(html, /active intersection/u);
  assert.doesNotMatch(html, /stale title/u);
  assert.match(html, /href="\/@\/thread\/other\/@\/missing%20wait"[^>]*>Missing wait</u);
});

test("Git arc waits show active claim owners without planned-only intersections", () => {
  const html = renderWithClient(
    createElement(ObservedThreadGitArcIntersectionCard, {
      harness: "codex",
      mode: "wait",
      threadId: "thread",
    }),
    planStore,
  );

  assert.match(html, /data-thread-git-arc-intersection-card="wait"/u);
  assert.match(html, /data-project-file-relative-path="src\/feature\/card.tsx"/u);
  assert.doesNotMatch(html, /data-project-file-relative-path="(?:docs\/unrelated.ts|src\/feature\/other.ts)"/u);
  assert.match(html, /href="\/@\/thread\/project\/@\/active%20intersection"/u);
  assert.doesNotMatch(html, /planned%20intersection|<details/u);
});

test("stashed tooltips identify live claim owners without listing paths or planned-only threads", async () => {
  const stashedOwner = planThread("thread", {
    checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "stashed",
    phase: "stashed", proposals: [], stashedPaths: ["src/feature"], updatedAt: "2026-08-27",
  }, {
    checkpointCommit: "b".repeat(40), intentDescription: "", intentName: "pending plan",
    scopePaths: ["docs"], updatedAt: "2026-08-27",
  });
  const snapshot = { ...planSnapshot, entries: [stashedOwner, activeIntersection, plannedIntersection] };
  const store = { ...planStore, getProjectSnapshot: () => snapshot };
  const html = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null, proposalId: null, sidebarStore: store,
  });
  assert.match(html, /data-thread-git-arc-intersection-card="stashed"/u);
  assert.match(html, /href="\/@\/thread\/project\/@\/active%20intersection"/u);
  assert.doesNotMatch(html, /data-project-file-relative-path=|planned%20intersection|<details/u);

  const clearHtml = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null, proposalId: null,
    sidebarStore: { ...planStore, getProjectSnapshot: () => ({ ...snapshot, entries: [stashedOwner] }) },
  });
  assert.match(clearHtml, /data-thread-git-arc-intersection-card="stashed"/u);
  assert.doesNotMatch(clearHtml, /data-thread-reference-list=/u);

  // Urgency order: the questionnaire leads, then active overlap, then the proposal.
  const busyHtml = await renderDetails(false, "C:/workspace", true, { sidebarStore: store });
  const cardStart = busyHtml.indexOf('data-thread-git-arc-intersection-card="stashed"');
  assert.notEqual(cardStart, -1);
  assert.ok(busyHtml.indexOf('data-thread-tooltip-questionnaire=') < cardStart);
  assert.ok(cardStart < busyHtml.indexOf('data-thread-tooltip-proposal='));
});

test("tooltips name required todos and only count optional ones", async () => {
  const todo = (id: number, required: boolean, text: string) => ({ createdAt: id, id, required, text }) as WorkbenchThreadTodo;
  const html = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null, proposalId: null,
    todos: [todo(1, true, "ship the tooltip"), todo(2, false, "polish later"), todo(3, false, "maybe never")],
  });
  assert.match(html, /ship the tooltip/u);
  assert.doesNotMatch(html, /polish later|maybe never/u);
  assert.match(html, /\+2 optional/u);

  const optionalOnly = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null, proposalId: null, todos: [todo(2, false, "polish later")],
  });
  assert.doesNotMatch(optionalOnly, /polish later/u);
  assert.match(optionalOnly, /1 optional todo</u);
});

test("tooltip proposals commit through the thread's own store, without a host-supplied cwd", async () => {
  const html = await renderDetails(false, "C:/elsewhere", true, {
    pendingRequest: null,
    proposalSummary: { changes: null, committedSha: null, description: "", mode: "commit", title: "ship the store wiring" },
  });
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
  assert.match(html, /ship the store wiring/u);
});

test("tooltip proposals are the status panel's list, with stack layers and commit all", async () => {
  const html = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null,
    stack: {
      proposalIds: ["lower", "upper"],
      stackLayers: [{ layerId: "layer", proposalIds: ["lower"], sealedAt: "2026-10-11", title: "Lower layer" }],
    },
  });
  assert.match(html, /data-thread-git-arc-commit-all="true"/u);
  assert.match(html, /data-thread-git-arc-stack-layer="layer"/u);
  assert.match(html, /data-thread-git-arc-proposal="lower"[\s\S]*data-thread-git-arc-proposal="upper"/u);
});

test("tooltips list the threads a thread waits for", async () => {
  const html = await renderDetails(false, "C:/workspace", true, {
    pendingRequest: null, proposalId: null,
    waitingOnThreads: [{
      identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("blocker") },
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      title: "Blocking work",
    }],
  });
  assert.match(html, /Waiting for/u);
  assert.match(html, /href="\/@\/thread\/project\/@\/blocker"[^>]*>Blocking work</u);
});
