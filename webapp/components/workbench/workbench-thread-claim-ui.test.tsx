/*
 * Exports:
 * - No production exports; rendered regression checks protect active claim counts, proposed-commit presentation, and settlement suppression. Keywords: sidebar, thread, claim, proposal, commit, settlement.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkbenchThreadSidebarEntrySchema, type WorkbenchThreadSidebarEntry } from "../../lib/workbench/thread/thread-state";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchContextMenuContext, { type WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

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
        phase: claimedPaths.length ? "active" : "resolved",
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
    }),
  ));
}

function renderThreadItem(entry: ThreadEntry, contextMenu: WorkbenchContextMenuDefinition | null = null) {
  return renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { closeContextMenu: () => undefined, openContextMenu: () => undefined } },
    createElement(WorkbenchThreadListItem, {
      contextMenu,
      entry,
      href: "/agent/thread/thread-one",
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
    phase: "active", proposals: [{ proposalId: "proposal-one", status: "proposed" }], reloadScopes: ["mcp"], updatedAt: "2026-08-20T00:00:00.000Z",
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

test("hanging proposals without claims do not expose settlement", () => {
  const html = renderThreadItem(createThreadEntry({
    claimedPaths: [],
    proposalStatus: "proposed",
    threadId: "proposal-only",
    title: "Commit still pending",
  }));
  assert.doesNotMatch(html, /aria-label="Settle"/u);
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

test("needs-attention thread rows use amber only during an active Git arc", () => {
  const needsAttentionLifecycle = { kind: "needsAttention" as const, reason: "pendingInput" as const, requestKey: "questionnaire:one", settled: false as const, turnId: "turn-two" };
  const inactiveEntry = createThreadEntry({ threadId: "inactive-attention", title: "Inactive attention" });
  const activeEntry = createThreadEntry({ claimedPaths: ["src/one.ts"], threadId: "active-attention", title: "Active attention" });
  const resolvedEntry = createThreadEntry({ threadId: "resolved-attention", title: "Resolved attention" });
  const inactiveHtml = renderThreadItem({ ...inactiveEntry, lifecycle: needsAttentionLifecycle });
  const activeHtml = renderThreadItem({ ...activeEntry, lifecycle: needsAttentionLifecycle });
  const resolvedHtml = renderThreadItem({
    ...resolvedEntry,
    gitArc: {
      checkpointCommit: "a".repeat(40), claimedPaths: [], intentDescription: "", intentName: "resolved",
      phase: "resolved", proposals: [], updatedAt: "2026-08-20T00:00:00.000Z",
    },
    lifecycle: needsAttentionLifecycle,
  });

  for (const html of [inactiveHtml, resolvedHtml]) {
    assert.match(html, /data-thread-status-tone="needs-attention"/u);
  }
  assert.match(activeHtml, /data-thread-status-tone="needs-attention-active"/u);
});

test("thread rows expose explicit context-menu access without a tooltip interception layer", async () => {
  const entry = createThreadEntry({ threadId: "menu", title: "Menu work" });
  const html = renderThreadItem(entry, {
    id: "thread:menu",
    items: [{ id: "open", label: "Open", onSelect: () => undefined }],
    label: "Thread actions for Menu work",
  });
  const source = await readFile(new URL("./WorkbenchThreadListItem.tsx", import.meta.url), "utf8");
  assert.match(html, /aria-label="More actions for Menu work"/u);
  assert.doesNotMatch(source, /WorkbenchTooltip|ThreadTooltipContent/u);
});
