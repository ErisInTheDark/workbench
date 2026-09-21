/*
 * Exports:
 * - No production exports; rendered regression checks protect claim and draft status, settlement, priority ordering, and compatible sidebar drag targets.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import {
  WorkbenchThreadSidebarEntrySchema,
  type WorkbenchProjectThreadSidebars,
  type WorkbenchProjectThreadSummaries,
  type WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchPinnedThreadList from "./WorkbenchPinnedThreadList";
import WorkbenchClientStateProvider from "./WorkbenchClientStateProvider";
import WorkbenchComposerDraftPresenceProvider from "./WorkbenchComposerDraftPresenceProvider";
import WorkbenchHomeThreadList from "./WorkbenchHomeThreadList";
import ThreadRateLimits from "./thread-view/ThreadRateLimits";
import WorkbenchSidebarPreferencesProvider from "./WorkbenchSidebarPreferencesProvider";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchContextMenuContext, { type WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchDragProvider from "./drag/WorkbenchDragProvider";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "alpha": fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    "beta": fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
    "other": fixtureIdentitySchemas.ProjectIdSchema.parse("other"),
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "alpha-pinned": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("alpha-pinned"),
    "beta-pinned": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("beta-pinned"),
    "remote-pin": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("remote-pin"),
    "source": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("source"),
  },
  WorkbenchTurnId: {
    "turn-one": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-one"),
    "turn-remote": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-remote"),
  },
};

test("draft composer controls render project rotation immediately before harness rotation", () => {
  const markup = renderToStaticMarkup(createElement(ThreadRateLimits, {
    harness: "codex",
    leadingContent: createElement("button", { type: "button" }, "Project alpha"),
    rateLimits: null,
  }));
  const projectIndex = markup.indexOf("Project alpha");
  const harnessIndex = markup.indexOf("Codex");
  assert.notEqual(projectIndex, -1);
  assert.notEqual(harnessIndex, -1);
  assert.equal(projectIndex < harnessIndex, true);
});

type ThreadEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;

function createThreadEntry({
  claimedPaths,
  proposalStatus = null,
  stashedPaths,
  threadId,
  title,
}: {
  claimedPaths?: string[];
  proposalStatus?: "committed" | "proposed" | null;
  stashedPaths?: string[];
  threadId: string;
  title: string;
}): ThreadEntry {
  const gitArc: ThreadEntry["gitArc"] = stashedPaths ? {
    checkpointCommit: "a".repeat(40),
    claimedPaths: [],
    intentDescription: "Protect the focused sidebar presentation.",
    intentName: "sidebar claim",
    phase: "stashed",
    proposals: proposalStatus ? [{ proposalId: "proposal-one", status: proposalStatus }] : [],
    stashedPaths,
    updatedAt: "2026-08-20T00:00:00.000Z",
  } : claimedPaths ? {
    checkpointCommit: "a".repeat(40),
    claimedPaths,
    intentDescription: "Protect the focused sidebar presentation.",
    intentName: "sidebar claim",
    phase: claimedPaths.length ? "active" : "resolved",
    proposals: proposalStatus ? [{ proposalId: "proposal-one", status: proposalStatus }] : [],
    updatedAt: "2026-08-20T00:00:00.000Z",
  } as ThreadEntry["gitArc"] : undefined;
  return {
    activityAt: 1_723_456_789_000,
    entryKind: "thread",
    ...(gitArc ? { gitArc } : {}),
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { agent: { agentStatus: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["turn-one"] }, kind: "completed", reason: "agentCompleted", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title,
  };
}

function renderThreads(
  entries: ThreadEntry[],
  showPinnedThreadsInMain = false,
  activeDragPayload: ComponentProps<typeof WorkbenchThreadList>["activeDragPayload"] = null,
  displayOrder: ComponentProps<typeof WorkbenchThreadList>["displayOrder"] = {},
) {
  return renderToStaticMarkup(createElement(
    WorkbenchSidebarPreferencesProvider,
    {
      children: () => createElement(
        WorkbenchContextMenuContext.Provider,
        { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined, refreshContextMenu: () => undefined } },
        createElement(WorkbenchDragProvider, null, createElement(WorkbenchThreadList, {
            activeDragPayload,
            currentTarget: null,
            displayOrder,
            entries,
            getThreadHref: () => "/agent/thread/thread-one",
            nowMs: 1_723_456_790_000,
            onCreateThread: () => undefined,
            onOpenThread: () => undefined,
            onProjectFolderDrop: () => undefined,
            onSetPriority: () => undefined,
            onSnoozeUntil: () => undefined,
            projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
            showPinnedThreadsInMain,
          })),
      ),
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    },
  ));
}

function renderPinnedThreads(
  projects: WorkbenchProjectOption[],
  projectThreadSummaries: WorkbenchProjectThreadSummaries,
  selectedProjectPinPlacement: ComponentProps<typeof WorkbenchPinnedThreadList>["selectedProjectPinPlacement"] = "pinned-section",
  activeDragPayload: ComponentProps<typeof WorkbenchPinnedThreadList>["activeDragPayload"] = null,
) {
  return renderToStaticMarkup(createElement(
    WorkbenchSidebarPreferencesProvider,
    {
      children: () => createElement(
        WorkbenchContextMenuContext.Provider,
        { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined, refreshContextMenu: () => undefined } },
        createElement(WorkbenchDragProvider, null, createElement(WorkbenchPinnedThreadList, {
          activeDragPayload,
          actions: {
            autoFocusFolderId: null,
            getThreadContextMenu: () => ({ id: "test-thread-menu", items: [], label: "Thread actions" }),
            nowMs: 1_723_456_790_000,
            onAction: () => undefined,
            onAutoFocusFolderComplete: () => undefined,
            onPinnedFolderDrop: () => undefined,
            onPinnedMove: () => undefined,
            onRenamePinnedFolder: async (_folderId, title) => title,
            onSetPriority: () => undefined,
            onSnoozeUntil: () => undefined,
            pinnedDisplayOrder: {},
            projectThreadSidebars: {
              projects: projectThreadSummaries.projects.map(summary => ({
                displayOrder: {},
                entries: summary.pinnedThreads.flatMap(entry => entry.entryKind === "thread" ? [entry] : []),
                error: "",
                freshness: "fresh" as const,
                projectId: summary.projectId,
                revision: summary.revision,
              })),
            },
            projectThreadSummaries,
          },
          currentTarget: null,
          onOpenThread: () => undefined,
          projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
          projects,
          selectedProjectPinPlacement,
          selectedOwnerProjectId: "project",
        })),
      ),
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    },
  ));
}

function renderHomeThreads({
  activeDragPayload = null,
  displayOrder = {},
  projectThreadSidebars,
  projects,
}: {
  activeDragPayload?: ComponentProps<typeof WorkbenchHomeThreadList>["activeDragPayload"];
  displayOrder?: ComponentProps<typeof WorkbenchHomeThreadList>["actions"]["homeDisplayOrder"];
  projectThreadSidebars: WorkbenchProjectThreadSidebars;
  projects: WorkbenchProjectOption[];
}) {
  const actions: ComponentProps<typeof WorkbenchHomeThreadList>["actions"] = {
    autoFocusFolderId: null,
    displayOrder: {},
    entries: [],
    error: "",
    getThreadContextMenu: () => ({ id: "home-thread-menu", items: [], label: "Thread actions" }),
    homeDisplayOrder: displayOrder,
    homeDisplayOrderSupported: true,
    isLoading: false,
    nowMs: 1_723_456_790_000,
    onAction: () => undefined,
    onAutoFocusFolderComplete: () => undefined,
    onHomeMove: () => undefined,
    onMove: () => undefined,
    onPinnedFolderDrop: () => undefined,
    onPinnedMove: () => undefined,
    onProjectFolderDrop: () => undefined,
    onRenameFolder: async (_folderId, title) => title,
    onRenamePinnedFolder: async (_folderId, title) => title,
    onSetPriority: () => undefined,
    onSnoozeUntil: () => undefined,
    pinnedDisplayOrder: {},
    projectThreadSidebars,
    projectThreadSummaries: { projects: [] },
  };
  return renderToStaticMarkup(createElement(
    WorkbenchSidebarPreferencesProvider,
    {
      children: () => createElement(
        WorkbenchContextMenuContext.Provider,
        { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined, refreshContextMenu: () => undefined } },
        createElement(WorkbenchDragProvider, null, createElement(WorkbenchHomeThreadList, {
          actions,
          activeDragPayload,
          attentionLabelsByThreadId: {},
          createProject: projects[0]!,
          currentTarget: null,
          onCreateThread: () => undefined,
          onOpenThread: () => undefined,
          projects,
          selectedOwnerProjectId: "",
        })),
      ),
      projectId: "",
    },
  ));
}

function renderThreadItem(
  entry: ThreadEntry,
  contextMenu: WorkbenchContextMenuDefinition | null = null,
  project?: WorkbenchProjectOption,
  { showPinPriorityIcon = false }: { showPinPriorityIcon?: boolean } = {},
) {
  return renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined, refreshContextMenu: () => undefined } },
    createElement(WorkbenchThreadListItem, {
      contextMenu,
      entry,
      href: "/agent/thread/thread-one",
      ...(project ? { project } : {}),
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      showActions: true,
      showPinPriorityIcon,
    }),
  ));
}

async function renderThreadItemWithComposerDraft(
  entry: ThreadEntry,
  value: { attachments: Array<{ id: string; url: string }>; text: string; updatedAt: number },
  rowProjectId = "project",
) {
  const controller = new WorkbenchClientStateController({ mode: "memory" });
  await controller.put({
    daemonRegistrationId: "memory",
    kind: "composerDraft",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    threadId: entry.identity.threadId,
    value,
  });
  return renderToStaticMarkup(createElement(
    WorkbenchClientStateProvider,
    {
      children: createElement(
        WorkbenchComposerDraftPresenceProvider,
        {
          children: createElement(
            WorkbenchContextMenuContext.Provider,
            { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined, refreshContextMenu: () => undefined } },
            createElement(WorkbenchThreadListItem, {
              entry,
              href: "/agent/thread/thread-one",
              projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(rowProjectId),
            }),
          ),
        },
      ),
      controller,
    },
  ));
}

test("thread rows render counts only for active file claims", () => {
  const claimedHtml = renderThreads([createThreadEntry({
    claimedPaths: ["src/one.ts", "src/two.ts", "src/three.ts"],
    threadId: "claimed",
    title: "Claimed work",
  })]);
  assert.match(claimedHtml, /aria-label="Claimed work, Completed, 3 claimed files,/u);
  assert.match(claimedHtml, /data-role="thread-file-claim"[\s\S]*?<span>3<\/span>/u);

  const unclaimedHtml = renderThreads([createThreadEntry({ threadId: "planned", title: "Planned work" })]);
  assert.doesNotMatch(unclaimedHtml, /data-role="thread-file-claim"|claimed files/u);
});

test("stashed arcs show the archive icon count and retained paths instead of live claims", () => {
  const html = renderThreads([createThreadEntry({
    stashedPaths: ["src/one.ts", "src/two.ts"],
    threadId: "stashed",
    title: "Stashed work",
  })]);
  assert.match(html, /aria-label="Stashed work, Completed, 2 stashed files,/u);
  assert.match(html, /data-role="thread-file-stash"[\s\S]*?<span>2<\/span>/u);
  assert.doesNotMatch(html, /data-role="thread-file-claim"/u);
});

test("claim-free thread rows show only non-empty composer drafts in the claim slot", async () => {
  const draftValue = { attachments: [], text: "send this later", updatedAt: 1 };
  const draftHtml = await renderThreadItemWithComposerDraft(
    createThreadEntry({ threadId: "drafted", title: "Drafted work" }),
    draftValue,
  );
  assert.match(draftHtml, /data-role="thread-composer-draft"/u);

  const attachmentHtml = await renderThreadItemWithComposerDraft(
    createThreadEntry({ threadId: "attached", title: "Attached work" }),
    { attachments: [{ id: "image-one", url: "data:image/png;base64,AA==" }], text: " ", updatedAt: 1 },
  );
  assert.match(attachmentHtml, /data-role="thread-composer-draft"/u);

  const emptyHtml = await renderThreadItemWithComposerDraft(
    createThreadEntry({ threadId: "empty", title: "Empty work" }),
    { attachments: [], text: " ", updatedAt: 1 },
  );
  assert.doesNotMatch(emptyHtml, /thread-composer-draft|unsent draft/u);

  const claimedHtml = await renderThreadItemWithComposerDraft(
    createThreadEntry({ claimedPaths: ["src/claimed.ts"], threadId: "claimed-draft", title: "Claimed draft" }),
    draftValue,
  );
  assert.match(claimedHtml, /data-role="thread-file-claim"/u);
  assert.doesNotMatch(claimedHtml, /thread-composer-draft|unsent draft/u);

  const otherProjectHtml = await renderThreadItemWithComposerDraft(
    createThreadEntry({ threadId: "drafted", title: "Other project work" }),
    draftValue,
    "other-project",
  );
  assert.doesNotMatch(otherProjectHtml, /thread-composer-draft|unsent draft/u);
});

test("thread rows expose waiting as a neutral working-icon status", () => {
  const html = renderThreadItem({ ...createThreadEntry({ threadId: "waiting", title: "Waiting work" }), waitingFor: "other" });
  assert.match(html, /aria-label="Waiting work, Waiting,/u);
  assert.match(html, /data-thread-status-tone="waiting"/u);
});

test("thread rows project resolved Git arcs without treating them as live file claims", () => {
  const entry = createThreadEntry({ threadId: "resolved", title: "Resolved work" });
  const html = renderThreads([{ ...entry, gitArc: {
    checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "resolved",
    phase: "resolved", proposals: [{ proposalId: "proposal-one", status: "committed" }], updatedAt: "2026-08-20T00:00:00.000Z",
  } } as never]);
  assert.doesNotMatch(html, /claimed files/u);
  assert.match(html, /Completed/u);
});

test("compact sidebar rows hide metadata only while a real action is available", () => {
  const entry = createThreadEntry({ threadId: "settled", title: "Settled work" });
  const html = renderThreadItem({
    ...entry,
    lifecycle: {
      agent: { agentStatus: "completed", turnId: fixtureIdentityValues.WorkbenchTurnId["turn-one"] },
      kind: "completed",
      reason: "agentCompleted",
      settled: true,
    },
  });
  assert.match(html, /aria-label="Restore"/u);
  assert.match(html, /group-hover\/thread-row:invisible/u);
});

test("thread state accepts phase-aware Git arc lifecycle state", () => {
  const entry = createThreadEntry({ threadId: "resolved-contract", title: "Resolved contract" });
  assert.equal(WorkbenchThreadSidebarEntrySchema.safeParse({
    ...entry,
    gitArc: {
      checkpointCommit: "a".repeat(40),
      claimedPaths: [],
      intentDescription: "",
      intentName: "resolved",
      phase: "resolved",
      proposals: [{ proposalId: "proposal-one", status: "committed" }],
      updatedAt: "2026-08-20T00:00:00.000Z",
    },
  }).success, true);
});

test("thread state projects inactive plan scope separately from live claims", () => {
  const entry = createThreadEntry({ threadId: "plan-contract", title: "Plan contract" });
  const parsed = WorkbenchThreadSidebarEntrySchema.safeParse({
    ...entry,
    gitArc: null,
    gitArcPlan: {
      checkpointCommit: "b".repeat(40),
      intentDescription: "Warn before activation.",
      intentName: "planned overlap",
      scopePaths: ["src/feature"],
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data.entryKind === "thread" ? parsed.data.gitArc : undefined, null);
});

test("sidebar derives proposed status and live claim count from gitArc", () => {
  const entry = createThreadEntry({ threadId: "git-arc-sidebar", title: "Git arc sidebar" });
  const html = renderThreads([{ ...entry, gitArc: {
    checkpointCommit: "a".repeat(40), claimedPaths: ["src/one.ts", "src/two.ts"], intentDescription: "", intentName: "active",
    phase: "active", proposals: [{ proposalId: "proposal-one", status: "proposed" }], reloadScopes: ["server:mcp"], updatedAt: "2026-08-20T00:00:00.000Z",
  } } as never]);
  assert.match(html, /aria-label="Git arc sidebar, Proposed commit, 2 claimed files,/u);
  assert.doesNotMatch(html, /3 claimed|runtime reload/u);
});

test("proposed commits replace the completed state", () => {
  const html = renderThreads([createThreadEntry({
    claimedPaths: ["src/one.ts", "src/two.ts"],
    proposalStatus: "proposed",
    threadId: "proposal",
    title: "Commit ready",
  })]);
  assert.match(html, /aria-label="Commit ready, Proposed commit, 2 claimed files,/u);
});

test("hanging proposals without claims preserve presentation and expose settlement", () => {
  const html = renderThreadItem(createThreadEntry({
    claimedPaths: [],
    proposalStatus: "proposed",
    threadId: "proposal-only",
    title: "Commit still pending",
  }));
  assert.match(html, /Commit still pending, Proposed commit,/u);
  assert.match(html, /aria-label="Settle"/u);
});

test("live lifecycle presentation outranks a hanging proposed commit", () => {
  const proposed = createThreadEntry({
    claimedPaths: ["src/one.ts", "src/two.ts"],
    proposalStatus: "proposed",
    threadId: "proposal",
    title: "Commit ready",
  });
  const cases = [
    {
      entry: { ...proposed, lifecycle: { agent: { agentStatus: "working" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-two") }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const } },
      label: "Working",
    },
    {
      entry: { ...proposed, lifecycle: { kind: "needsAttention" as const, reason: "pendingInput" as const, requestKey: "questionnaire:one", settled: false as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-two") } },
      label: "Needs attention",
    },
    {
      entry: { ...proposed, lifecycle: { kind: "stopped" as const, reason: "providerInterrupted" as const, settled: false as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-two") } },
      label: "Stopped",
    },
  ];

  for (const { entry, label } of cases) {
    const html = renderThreads([entry]);
    assert.match(html, new RegExp(`aria-label="Commit ready, ${label}, 2 claimed files,`, "u"));
    assert.doesNotMatch(html, /Proposed commit/u);
  }
});

test("thread rows expose explicit context-menu access alongside interactive tooltips", async () => {
  const entry = createThreadEntry({ threadId: "menu", title: "Menu work" });
  const html = renderThreadItem(entry, {
    id: "thread:menu",
    items: [{ id: "open", label: "Open", onSelect: () => undefined }],
    label: "Thread actions for Menu work",
  });
  const source = await readFile(new URL("./WorkbenchThreadListItem.tsx", import.meta.url), "utf8");
  assert.match(html, /aria-label="More actions for Menu work"/u);
  assert.match(source, /<WorkbenchTooltip[\s\S]*?enabled=\{showTooltip && !isDragActive\}[\s\S]*?interactive[\s\S]*?<a/u);
  assert.match(source, /data-thread-project-file-link-boundary="true"/u);
  assert.match(source, /claimedPaths\.map\(\(filePath\)[\s\S]*?<ProjectFilePath/u);
});

test("global pinned disclosure starts open, omits thread creation, and identifies each project", () => {
  const localPinned = {
    ...createThreadEntry({ threadId: "local-pin", title: "Local pin" }),
    lifecycle: { agent: { agentStatus: "working" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-local") }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const },
    metadata: { archived: false as const, pinned: true, snoozed: false },
  };
  const projects: WorkbenchProjectOption[] = [{
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), kind: "git", lastCommitTimeMs: null, name: "Workbench", relativePath: "web/workbench",
    rootPath: "C:/git/web/workbench", roots: [{ id: "workbench", isPrimary: true, name: "workbench", relativePath: "web/workbench", rootPath: "C:/git/web/workbench" }],
  }, {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), kind: "git", lastCommitTimeMs: null, name: "Other", relativePath: "web/other",
    rootPath: "C:/git/web/other", roots: [{ id: "other", isPrimary: true, name: "other", relativePath: "web/other", rootPath: "C:/git/web/other" }],
  }];
  const projectThreadSummaries: WorkbenchProjectThreadSummaries = {
    projects: [{
      counts: { completed: 0, needsAttention: 0, needsAttentionActive: 0, proposedCommit: 0, stopped: 0, working: 1 },
      lastThreadUpdateAt: localPinned.activityAt,
      pinnedThreads: [{
        activityAt: localPinned.activityAt,
        canCompleteQuestionnaire: false,
        entryKind: "thread",
        identity: localPinned.identity,
        lifecycle: localPinned.lifecycle,
        metadata: { archived: false, pinned: true, snoozed: false },
        status: "working",
        title: localPinned.title,
      }],
      projectId: fixtureIdentityValues.ProjectId["project"],
      revision: 1,
      unsettledThreads: [{ activityAt: localPinned.activityAt, identity: localPinned.identity, status: "working", title: localPinned.title }],
    }, {
      counts: { completed: 0, needsAttention: 0, needsAttentionActive: 0, proposedCommit: 0, stopped: 1, working: 0 },
      lastThreadUpdateAt: localPinned.activityAt,
      pinnedThreads: [{
        activityAt: localPinned.activityAt,
        canCompleteQuestionnaire: false,
        entryKind: "thread",
        identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["remote-pin"] },
        lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn-remote"] },
        metadata: { archived: false, pinned: true, snoozed: false },
        status: "stopped",
        title: "Remote pin",
      }],
      projectId: fixtureIdentityValues.ProjectId["other"],
      revision: 1,
      unsettledThreads: [{ activityAt: localPinned.activityAt, identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["remote-pin"] }, status: "stopped", title: "Remote pin" }],
    }],
  };
  const html = renderPinnedThreads(projects, projectThreadSummaries);

  assert.match(html, /<details[^>]*open=""/u);
  assert.doesNotMatch(html, /Create new thread/u);
  const localRowHtml = renderThreadItem(localPinned, null, projects[0]);
  const remoteRowHtml = renderThreadItem({
    ...createThreadEntry({ threadId: "remote-pin", title: "Remote pin" }),
    lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn-remote"] },
    metadata: { archived: false, pinned: true, snoozed: false },
  }, null, projects[1]);
  assert.match(localRowHtml, /Workbench[\s\S]*?web\/workbench[\s\S]*?Local pin/u);
  assert.match(remoteRowHtml, /Other[\s\S]*?web\/other[\s\S]*?Remote pin/u);
  assert.doesNotMatch(`${localRowHtml}${remoteRowHtml}`, /data-role="thread-priority-icon"/u);

  const relocatedPinnedHtml = renderPinnedThreads(projects, projectThreadSummaries, "threads-section");
  assert.doesNotMatch(relocatedPinnedHtml, /Local pin/u);
  assert.match(relocatedPinnedHtml, /Remote pin/u);
  const relocatedMainHtml = renderThreads([localPinned], true);
  assert.match(relocatedMainHtml, /Local pin/u);
  assert.match(relocatedMainHtml, /data-role="thread-priority-icon" data-thread-priority="pinned"/u);

  const dragHtml = renderPinnedThreads(projects, projectThreadSummaries, "pinned-section", {
    ownerProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("source-project"),
    projectSourceKey: fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:source"),
    section: "main",
    sourceKey: "codex:source",
    target: { kind: "thread", target: { harness: "codex", kind: "provider", threadId: fixtureIdentityValues.WorkbenchThreadId["source"] } },
    type: "thread-row",
  });
  assert.doesNotMatch(dragHtml, /data-thread-priority-drop-target="pinned"/u);
  assert.match(dragHtml, /data-thread-insertion-target="pinned"/u);
  assert.equal((dragHtml.match(/data-thread-drag-target="folder"/gu) ?? []).length, 2);
  assert.equal((dragHtml.match(/data-thread-drag-target-scope="row"/gu) ?? []).length, 4);
  assert.equal((dragHtml.match(/data-thread-drag-target="dependent-snooze"/gu) ?? []).length, 2);
});

test("project thread drag exposes group outcomes and folder targets only in folder-capable priorities", () => {
  const needsAttention = { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const };
  const pinned = {
    ...createThreadEntry({ threadId: "pinned-target", title: "Pinned target" }),
    lifecycle: needsAttention,
    metadata: { archived: false as const, pinned: true, snoozed: false },
  };
  const ungroupedPinned = {
    ...createThreadEntry({ threadId: "ungrouped-pinned-target", title: "Ungrouped pinned target" }),
    lifecycle: needsAttention,
    metadata: { archived: false as const, pinned: true, snoozed: false },
  };
  const main = {
    ...createThreadEntry({ threadId: "main-target", title: "Main target" }),
    lifecycle: needsAttention,
  };
  const snoozed = {
    ...createThreadEntry({ threadId: "snoozed-target", title: "Snoozed target" }),
    lifecycle: needsAttention,
    metadata: { archived: false as const, pinned: false, snoozed: true },
  };
  const html = renderThreads([pinned, ungroupedPinned, main, snoozed], true, {
    ownerProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    projectSourceKey: fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:source"),
    section: "main",
    sourceKey: "codex:source",
    target: { kind: "thread", target: { harness: "codex", kind: "provider", threadId: fixtureIdentityValues.WorkbenchThreadId["source"] } },
    type: "thread-row",
  }, {
    folders: [{
      folderId: fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000202"),
      section: "pinned",
      threadKeys: ["codex:pinned-target"],
      title: "Pinned folder",
    }],
  });

  assert.match(html, /Pinned folder/u);
  assert.match(html, /data-thread-insertion-target="pinned"/u);
  assert.match(html, /data-thread-insertion-target="snoozed"/u);
  assert.doesNotMatch(html, /data-thread-priority-drop-target="main"/u);
  assert.doesNotMatch(html, /data-thread-priority-drop-target="pinned"/u);
  assert.doesNotMatch(html, /data-thread-priority-drop-target="snoozed"/u);
  assert.equal((html.match(/data-thread-drag-target="folder"/gu) ?? []).length, 3);
  assert.equal((html.match(/data-thread-drag-target="folder"[^>]*data-thread-drag-target-scope="folder"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-thread-drag-target="dependent-snooze"/gu) ?? []).length, 3);
});

test("only home thread rows show pin while snooze keeps priority", () => {
  const pinnedEntry = {
    ...createThreadEntry({ threadId: "pinned", title: "Pinned" }),
    metadata: { archived: false as const, pinned: true, snoozed: false },
  };
  const projectPinnedHtml = renderThreadItem(pinnedEntry);
  const homePinnedHtml = renderThreadItem(pinnedEntry, null, undefined, { showPinPriorityIcon: true });
  const pinnedAndSnoozedHtml = renderThreadItem({
    ...createThreadEntry({ threadId: "pinned-snoozed", title: "Pinned and snoozed" }),
    metadata: { archived: false, pinned: true, snoozed: true },
  }, null, undefined, { showPinPriorityIcon: true });
  const ordinaryHtml = renderThreadItem(createThreadEntry({ threadId: "ordinary", title: "Ordinary" }));

  assert.doesNotMatch(projectPinnedHtml, /data-role="thread-priority-icon"/u);
  assert.match(homePinnedHtml, /data-role="thread-priority-icon" data-thread-priority="pinned"/u);
  assert.match(pinnedAndSnoozedHtml, /data-role="thread-priority-icon" data-thread-priority="snoozed"/u);
  assert.doesNotMatch(pinnedAndSnoozedHtml, /data-thread-priority="pinned"/u);
  assert.doesNotMatch(ordinaryHtml, /data-role="thread-priority-icon"/u);
});

test("settled home thread rows retain pin priority", () => {
  const html = renderThreadItem({
    ...createThreadEntry({ threadId: "settled-pinned", title: "Settled pinned" }),
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: true, snoozed: false },
  }, null, undefined, { showPinPriorityIcon: true });

  assert.match(html, /aria-label="Restore"/u);
  assert.match(html, /data-role="thread-priority-icon" data-thread-priority="pinned"/u);
});

test("home renders one combined priority list with project-owned folders and foreign drag blocking", () => {
  const projects: WorkbenchProjectOption[] = [{
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), kind: "git", lastCommitTimeMs: null, name: "Alpha", relativePath: "web/alpha",
    rootPath: "C:/git/web/alpha", roots: [{ id: "alpha", isPrimary: true, name: "alpha", relativePath: "web/alpha", rootPath: "C:/git/web/alpha" }],
  }, {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), kind: "git", lastCommitTimeMs: null, name: "Beta", relativePath: "web/beta",
    rootPath: "C:/git/web/beta", roots: [{ id: "beta", isPrimary: true, name: "beta", relativePath: "web/beta", rootPath: "C:/git/web/beta" }],
  }];
  const alphaPinned = { ...createThreadEntry({ threadId: "alpha-pinned", title: "Alpha pinned" }), metadata: { archived: false as const, pinned: true, snoozed: false } };
  const alphaMain = {
    ...createThreadEntry({ threadId: "alpha-main", title: "Alpha main" }),
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
  };
  const alphaSettled = {
    ...createThreadEntry({ threadId: "alpha-settled", title: "Alpha settled" }),
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: true as const },
  };
  const betaPinned = { ...createThreadEntry({ threadId: "beta-pinned", title: "Beta pinned" }), metadata: { archived: false as const, pinned: true, snoozed: false } };
  const betaSnoozed = {
    ...createThreadEntry({ threadId: "beta-snoozed", title: "Beta snoozed" }),
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
    metadata: { archived: false as const, pinned: false, snoozed: true },
  };
  const folderId = fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000303");
  const projectThreadSidebars: WorkbenchProjectThreadSidebars = {
    projects: [{
      displayOrder: { folders: [{ folderId, section: "pinned", threadKeys: ["codex:alpha-pinned"], title: "Alpha folder" }] },
      entries: [alphaPinned, alphaMain, alphaSettled],
      error: null,
      freshness: "fresh",
      projectId: fixtureIdentityValues.ProjectId["alpha"],
      revision: 1,
    }, {
      displayOrder: {},
      entries: [betaPinned, betaSnoozed],
      error: null,
      freshness: "fresh",
      projectId: fixtureIdentityValues.ProjectId["beta"],
      revision: 1,
    }],
  };
  const html = renderHomeThreads({
    activeDragPayload: {
      ownerProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
      projectSourceKey: fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:beta-pinned"),
      section: "pinned",
      sourceKey: "beta/codex%3Abeta-pinned",
      target: { kind: "thread", target: { harness: "codex", kind: "provider", threadId: fixtureIdentityValues.WorkbenchThreadId["beta-pinned"] } },
      type: "home-thread-row",
    },
    projectThreadSidebars,
    projects,
  });
  const createIndex = html.indexOf("href=\"/@/thread/alpha/@/new\"");
  const alphaFolderIndex = html.indexOf("Alpha folder");
  const betaPinnedIndex = html.indexOf("Beta pinned");
  const mainIndex = html.indexOf("Alpha main");
  const snoozedIndex = html.indexOf("Beta snoozed");
  const settledIndex = html.indexOf("Settled threads");
  assert.equal(createIndex >= 0, true);
  assert.equal(alphaFolderIndex > createIndex, true);
  assert.equal(betaPinnedIndex > createIndex, true);
  assert.equal(mainIndex > alphaFolderIndex && mainIndex > betaPinnedIndex, true);
  assert.equal(snoozedIndex > mainIndex, true);
  assert.equal(settledIndex > snoozedIndex, true);
  assert.doesNotMatch(html, /Pinned threads/u);
  assert.match(html, /data-role="thread-priority-icon" data-thread-priority="pinned"/u);
  assert.match(html, /Alpha[\s\S]*?web\/alpha[\s\S]*?Alpha folder/u);
  assert.match(html, /href="\/@\/thread\/beta\/@\/beta-pinned"/u);
  assert.match(html, /group\/thread-folder relative pointer-events-none/u);
  assert.match(html, /data-thread-priority-drop-target="main"/u);
  assert.match(html, /data-thread-insertion-target="pinned"/u);
  assert.match(html, /data-thread-insertion-target="snoozed"/u);
  assert.doesNotMatch(html, /data-thread-priority-drop-target="pinned"/u);
  assert.doesNotMatch(html, /data-thread-priority-drop-target="snoozed"/u);
  assert.equal((html.match(/data-thread-drag-target="folder"/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /data-thread-drag-target="folder"[^>]*data-thread-drag-target-scope="folder"/u);
  assert.equal((html.match(/data-thread-drag-target="dependent-snooze"/gu) ?? []).length, 2);
  assert.match(html, /data-thread-drag-target="dependent-snooze" data-thread-drag-target-project="alpha"/u);
  assert.match(html, /data-thread-drag-target="dependent-snooze" data-thread-drag-target-project="beta"/u);

  const sameProjectHtml = renderHomeThreads({
    activeDragPayload: {
      ownerProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
      projectSourceKey: fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:alpha-pinned"),
      section: "pinned",
      sourceKey: "alpha/codex%3Aalpha-pinned",
      target: { kind: "thread", target: { harness: "codex", kind: "provider", threadId: fixtureIdentityValues.WorkbenchThreadId["alpha-pinned"] } },
      type: "home-thread-row",
    },
    projectThreadSidebars,
    projects,
  });
  assert.match(sameProjectHtml, /group\/thread-folder relative"/u);
  assert.doesNotMatch(sameProjectHtml, /group\/thread-folder relative pointer-events-none/u);
});

test("other-project status subtraction removes pins and clamps mixed-version underflow", () => {
  assert.deepEqual(WorkbenchThreadStatusCounts.subtractCounts(
    { completed: 1, needsAttention: 0, needsAttentionActive: 0, proposedCommit: 0, stopped: 0, waiting: 1, working: 1 },
    { completed: 2, needsAttention: 0, needsAttentionActive: 0, proposedCommit: 0, stopped: 0, waiting: 1, working: 1 },
  ), {
    completed: 0,
    needsAttention: 0,
    needsAttentionActive: 0,
    proposedCommit: 0,
    stopped: 0,
    waiting: 0,
    working: 0,
  });
});
