/*
 * Exports:
 * - No production exports; rendered regression checks protect active claim counts and proposed-commit sidebar presentation. Keywords: sidebar, thread, claim, proposal, commit.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchThreadSidebarEntry } from "../../lib/workbench/thread/thread-state";
import WorkbenchThreadList from "./WorkbenchThreadList";
import WorkbenchContextMenuContext from "./WorkbenchContextMenuContext";

type ThreadEntry = Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>;

function createThreadEntry({
  claimedPaths,
  pinned = false,
  proposalStatus = null,
  threadId,
  title,
}: {
  claimedPaths?: string[];
  pinned?: boolean;
  proposalStatus?: "committed" | "proposed" | "superseded" | "unavailable" | null;
  threadId: string;
  title: string;
}): ThreadEntry {
  return {
    activityAt: 1_723_456_789_000,
    entryKind: "thread",
    ...(claimedPaths ? {
      fileClaim: {
        checkpointCommit: "a".repeat(40),
        claimedPaths,
        intentDescription: "Protect the focused sidebar presentation.",
        intentName: "sidebar claim",
        proposalId: proposalStatus ? "proposal-one" : null,
        proposalStatus,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    } : {}),
    identity: { harness: "codex", threadId },
    lifecycle: { agent: { agentStatus: "completed", turnId: "turn-one" }, kind: "completed", reason: "agentCompleted", settled: false },
    metadata: { archived: false, pinned, snoozed: false },
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

test("thread rows render counts only for active file claims", () => {
  const claimedHtml = renderThreads([createThreadEntry({
    claimedPaths: ["src/one.ts", "src/two.ts", "src/three.ts"],
    threadId: "claimed",
    title: "Claimed work",
  })]);
  assert.match(claimedHtml, /aria-label="Claimed work, Completed, 3 claimed files,/u);
  assert.match(claimedHtml, /data-role="thread-file-claim"[\s\S]*?<span>3<\/span>/u);
  assert.match(claimedHtml, /d="M6 22V2\.8a\.8\.8 0 0 1 1\.17-\.71l11\.38 5\.69a\.8\.8 0 0 1 0 1\.44L6 15\.5"/u);
  assert.doesNotMatch(claimedHtml, /data-role="thread-priority-icon"/u);
  assert.doesNotMatch(claimedHtml, /with file claims/u);

  const unclaimedHtml = renderThreads([createThreadEntry({ threadId: "planned", title: "Planned work" })]);
  assert.doesNotMatch(unclaimedHtml, /data-role="thread-file-claim"|claimed files/u);
});

test("proposed commits replace the completed label and inner status glyph", () => {
  const html = renderThreads([createThreadEntry({
    claimedPaths: ["src/one.ts", "src/two.ts"],
    proposalStatus: "proposed",
    threadId: "proposal",
    title: "Commit ready",
  })]);
  assert.match(html, /aria-label="Commit ready, Proposed commit, 2 claimed files,/u);
  assert.match(html, /d="M7\.5 12h2\.9m3\.2 0h2\.9"/u);
  assert.doesNotMatch(html, /Completed with proposed commit/u);
});

test("claim and pin controls use independent auto-sized slots", async () => {
  const source = await readFile(new URL("./WorkbenchThreadList.tsx", import.meta.url), "utf8");
  assert.match(source, /grid grid-cols-\[auto_auto\] items-center gap-1\.5/u);
  assert.match(source, /data-role="thread-file-claim"[\s\S]*?<PinIcon/u);
});

test("thread tooltips render every claimed path in an interactive wrapping scroll region", async () => {
  const source = await readFile(new URL("./WorkbenchThreadList.tsx", import.meta.url), "utf8");
  assert.match(source, /<WorkbenchTooltip[\s\S]*?interactive[\s\S]*?<a/u);
  assert.match(source, /data-thread-project-file-link-boundary="true"/u);
  assert.match(source, /claimedPaths\.map\(\(filePath\)[\s\S]*?<ProjectFilePath/u);
  assert.match(source, /flex max-h-56 min-h-0 flex-wrap content-start items-center gap-1 overflow-y-auto rounded-\[0\.65rem\] bg-\[color-mix\(in_srgb,var\(--text\)_4%,transparent\)\] p-2/u);
  assert.match(source, /overflow-y-auto[\s\S]*?<FlagIcon[\s\S]*?claimedPaths\.map/u);
  assert.doesNotMatch(source, />Claimed files<\/span>/u);
  assert.match(source, /title=\{entry\.title\}/u);
  assert.doesNotMatch(source, /<a[\s\S]*?title=\{entry\.title\}[\s\S]*?onClick=/u);
});
