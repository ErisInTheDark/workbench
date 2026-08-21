/*
 * Exports:
 * - No production exports; rendered regression checks protect active claim counts and proposed-commit sidebar presentation. Keywords: sidebar, thread, claim, proposal, commit.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkbenchThreadSidebarEntrySchema, type WorkbenchThreadSidebarEntry } from "../../lib/workbench/thread/thread-state";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchContextMenuContext from "./WorkbenchContextMenuContext";

type ThreadEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;

function createThreadEntry({
  claimedPaths,
  proposalStatus = null,
  threadId,
  title,
}: {
  claimedPaths?: string[];
  proposalStatus?: "committed" | "proposed" | null;
  threadId: string;
  title: string;
}): ThreadEntry {
  return {
    activityAt: 1_723_456_789_000,
    entryKind: "thread",
    ...(claimedPaths ? {
      gitArc: {
        checkpointCommit: "a".repeat(40),
        claimedPaths,
        intentDescription: "Protect the focused sidebar presentation.",
        intentName: "sidebar claim",
        phase: "active",
        proposals: proposalStatus ? [{ proposalId: "proposal-one", status: proposalStatus }] : [],
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    } : {}),
    identity: { harness: "codex", threadId },
    lifecycle: { agent: { agentStatus: "completed", turnId: "turn-one" }, kind: "completed", reason: "agentCompleted", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title,
  };
}

function renderThreads(entries: ThreadEntry[]) {
  return renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined } },
    createElement(WorkbenchThreadList, {
      currentTarget: null,
      entries,
      getThreadHref: () => "/agent/thread/thread-one",
      nowMs: 1_723_456_790_000,
      onCreateThread: () => undefined,
      onOpenThread: () => undefined,
      projectId: "project",
    }),
  ));
}

function renderThreadItem(entry: ThreadEntry) {
  return renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined } },
    createElement(WorkbenchThreadListItem, {
      entry,
      href: "/agent/thread/thread-one",
      projectId: "project",
      showActions: true,
    }),
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
      agent: { agentStatus: "completed", turnId: "turn-one" },
      kind: "completed",
      reason: "agentCompleted",
      settled: true,
    },
  });
  assert.match(html, /aria-label="Restore"/u);
  assert.match(html, /group-hover\/thread-row:invisible/u);
  assert.match(html, /group-focus-within\/thread-row:invisible/u);
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
    phase: "active", proposals: [{ proposalId: "proposal-one", status: "proposed" }], updatedAt: "2026-08-20T00:00:00.000Z",
  } } as never]);
  assert.match(html, /aria-label="Git arc sidebar, Proposed commit, 2 claimed files,/u);
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

test("live lifecycle presentation outranks a hanging proposed commit", () => {
  const proposed = createThreadEntry({
    claimedPaths: ["src/one.ts", "src/two.ts"],
    proposalStatus: "proposed",
    threadId: "proposal",
    title: "Commit ready",
  });
  const cases = [
    {
      entry: { ...proposed, lifecycle: { agent: { agentStatus: "working" as const, turnId: "turn-two" }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const } },
      label: "Working",
    },
    {
      entry: { ...proposed, lifecycle: { kind: "needsAttention" as const, reason: "pendingInput" as const, requestKey: "questionnaire:one", settled: false as const, turnId: "turn-two" } },
      label: "Needs attention",
    },
    {
      entry: { ...proposed, lifecycle: { kind: "stopped" as const, reason: "providerInterrupted" as const, settled: false as const, turnId: "turn-two" } },
      label: "Stopped",
    },
  ];

  for (const { entry, label } of cases) {
    const html = renderThreads([entry]);
    assert.match(html, new RegExp(`aria-label="Commit ready, ${label}, 2 claimed files,`, "u"));
    assert.doesNotMatch(html, /Proposed commit/u);
  }
});

test("thread tooltips expose every claimed path through interactive project links", async () => {
  const source = await readFile(new URL("./WorkbenchThreadListItem.tsx", import.meta.url), "utf8");
  assert.match(source, /<WorkbenchTooltip[\s\S]*?interactive[\s\S]*?\{anchor\}/u);
  assert.match(source, /data-thread-project-file-link-boundary="true"/u);
  assert.match(source, /claimedPaths\.map\(\(filePath\)[\s\S]*?<ProjectFilePath/u);
  assert.match(source, /title=\{entry\.title\}/u);
  assert.doesNotMatch(source, /<a[\s\S]*?title=\{entry\.title\}[\s\S]*?onClick=/u);
});

test("sidebar and planned-conflict card share grouping and the real thread item", async () => {
  const [listSource, cardSource] = await Promise.all([
    readFile(new URL("./WorkbenchThreadList.tsx", import.meta.url), "utf8"),
    readFile(new URL("./thread-view/ThreadPlanConflictCard.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(listSource, /groupWorkbenchThreadSidebarEntries\(entries\)/u);
  assert.match(listSource, /<WorkbenchThreadListItem/u);
  assert.match(cardSource, /createWorkbenchThreadPlanConflictSelector/u);
  assert.match(cardSource, /<WorkbenchThreadListItem[\s\S]*?compact[\s\S]*?showTooltip=\{false\}/u);
  assert.doesNotMatch(cardSource, /\bborder-t(?:\s|")|\bdivide-y|WorkbenchTooltip/u);
});
