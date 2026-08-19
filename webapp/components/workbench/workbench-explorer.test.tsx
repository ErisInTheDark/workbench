/*
 * Exports:
 * - No production exports; static regression checks cover thread-row accessibility, grouped context actions, lifecycle styling, and agent tabs. Keywords: explorer, sidebar, context menu, tablist, keyboard.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("threads render one flat tablist with lifecycle borders and all settled rows inside one disclosure", async () => {
  const source = await readFile(new URL("./WorkbenchThreadList.tsx", import.meta.url), "utf8");
  assert.match(source, /role="tablist"/u);
  assert.match(source, /role="tab"/u);
  assert.match(source, /event\.key === "ArrowDown"/u);
  assert.match(source, /event\.key === "ArrowUp"/u);
  assert.match(source, /event\.key === "Home"/u);
  assert.match(source, /event\.key === "End"/u);
  assert.match(source, /summary="Settled threads"/u);
  assert.match(source, /settledEntries\.map\(renderEntry\)/u);
  assert.doesNotMatch(source, /pinnedSettledEntries/u);
  assert.doesNotMatch(source, /<h3/u);
  assert.match(source, /grid-cols-\[minmax\(0,1fr\)_auto\]/u);
  assert.match(source, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/u);
  assert.match(source, /grid-cols-\[minmax\(0,1fr\)_auto\] px-2 pt-1\.5/u);
  assert.match(source, /grid-cols-\[auto_minmax\(0,1fr\)_auto_auto\][\s\S]*?px-2 pb-1\.5/u);
  assert.doesNotMatch(source, /grid-cols-subgrid/u);
  assert.match(source, /<rect/u);
  assert.match(source, /rx="12\.8"/u);
  assert.match(source, /fill="color-mix\(in srgb, var\(--text\) 4%, transparent\)"/u);
  assert.match(source, /stroke="currentColor"/u);
  assert.match(source, /strokeDasharray=\{hasDashedBorder \? "6 4" : undefined\}/u);
  assert.match(source, /transition-opacity duration-75 ease-out/u);
  assert.match(source, /group-hover\/thread-row:opacity-100 group-focus-within\/thread-row:opacity-100/u);
  assert.doesNotMatch(source, /repeating-linear-gradient/u);
  assert.match(source, /hasDashedBorder = entry\.entryKind === "draft" \|\| lifecycle\?\.kind === "needsAttention" \|\| lifecycle\?\.kind === "stopped"/u);
  assert.doesNotMatch(source, /hasDashedLifecycleBorder/u);
  assert.match(source, /hover:text-text focus-visible:flex focus-visible:text-text/u);
  assert.match(source, /aria-label=\{actionLabel\}[\s\S]*?cursor-pointer/u);
  assert.doesNotMatch(source, /aria-label=\{actionLabel\}[\s\S]*?hover:bg-/u);
  assert.match(source, /<a[\s\S]*?href=\{getThreadHref\(target\)\}[\s\S]*?role="tab"/u);
  assert.match(source, /href=\{getThreadHref\(\{ kind: "new" \}\)\}/u);
  assert.match(source, /event\.preventDefault\(\);[\s\S]*?onOpenThread\(target\)/u);
  assert.doesNotMatch(source, /Retry draft save|onRetryDraft/u);
  assert.doesNotMatch(source, /Draft · Saving|Draft · Save failed|draftSaveStates/u);
  assert.match(source, /entry\.entryKind === "draft"[\s\S]*?\? "text-muted"/u);
  assert.match(source, /flex flex-col gap-1/u);
  assert.match(source, /canComplete = entry\.entryKind === "thread" && !isWorkbenchThreadStatusProviderOwned\(entry\.lifecycle\)/u);
  assert.match(source, /canShiftSettle && isShiftPressed \? "settle" : baseAction/u);
  assert.match(source, /event\.shiftKey \|\| event\.detail > 1/u);
  assert.match(source, /action === "complete" \? "Completed"/u);
  assert.match(source, /: "Wake"/u);
  assert.match(source, /action === "discard" \? null : <span>\{actionLabel\}<\/span>/u);
  assert.match(source, /col-start-3 row-start-1[\s\S]*?group-hover\/thread-row:invisible/u);
  assert.match(source, /row-start-1 -mt-1 -mb-1 ml-0 mr-0/u);
  assert.doesNotMatch(source, /workbenchThreadListLabelClassName\} mr-1\.5 truncate/u);
  assert.ok(source.includes('<div className="pointer-events-none relative z-10 min-w-0">'));
  assert.doesNotMatch(source, /absolute right-1|top-1\/2|-translate-y-1\/2/u);
  assert.match(source, /contentClassName="mt-1"/u);
  assert.doesNotMatch(source, /summaryClassName="px-2/u);
  assert.match(source, /actionLabel === "restore"|action === "restore"/u);
  assert.match(source, /attentionLabelsByThreadId/u);
  assert.match(source, /font-semibold text-text/u);
  assert.doesNotMatch(source, /\$\{baseStatus\}, Snoozed/u);
});

test("agent tabs keep a persistent settled toggle and a straight accent-colored selector", async () => {
  const source = await readFile(new URL("./thread-view/ThreadAgentTabs.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-expanded=\{isSettledSubagentsVisible\}/u);
  assert.match(source, /\? "Hide" : "Show"\} settled subagents/u);
  assert.match(source, /absolute inset-x-1 bottom-0 border-t border-dotted/u);
  assert.doesNotMatch(source, /borderBottomColor/u);
  assert.match(source, /getThreadAgentAccentColor\(tab\.subagent\).*35%/u);
  assert.match(source, /LockIcon/u);
  assert.match(source, /UnlockIcon/u);
  assert.match(source, /Restore subagent/u);
  assert.match(source, /Settle subagent/u);
  assert.match(source, /href=\{getThreadHref\(tab\.id\)\}/u);
  assert.match(source, /href=\{getThreadHref\(mainThreadId\)\}/u);
  assert.match(source, /handleThreadLinkClick/u);
  assert.match(source, /threadSidebarStore\?\.getSnapshot\(\)\?\.entries\.find/u);
  assert.match(source, /entry\.identity\.harness === mainThreadHarness/u);
  assert.match(source, /<ThreadLifecycleStatusIcon lifecycle=\{mainThreadLifecycle\} \/>\s*<span>Main agent<\/span>/u);
  assert.doesNotMatch(source, /badge|unread|ThreadQuestionBadge/u);
});

test("existing-thread composer drafts keep their keyed owner through active subagent selection", async () => {
  const source = await readFile(new URL("./thread-view/ThreadView.tsx", import.meta.url), "utf8");
  assert.match(source, /threadComposerDraftsByThreadId\[activeThread\.id\] \?\? null/u);
  assert.match(source, /setActiveThreadId\(selectedThreadId \?\? thread\.id\)/u);
  assert.doesNotMatch(source, /setActiveThreadId\(thread\.id\)/u);
});

test("provider child routes canonicalize from durable subagent relationships", async () => {
  const source = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  assert.match(source, /explorer\.subagents\.find/u);
  assert.match(source, /const parentThreadId = relationship\?\.parentThreadId/u);
  assert.doesNotMatch(source, /explorer\.threadSidebar/u);
  assert.match(source, /const handleSelectedThreadChange = useCallback/u);
  assert.match(source, /selectedThreadId=\{selectedThreadIdForView\}/u);
  assert.match(source, /onSelectedThreadChange=\{handleSelectedThreadChange\}/u);
  assert.match(source, /kind: "subagent"/u);
  assert.match(source, /parentThreadId,/u);
  assert.match(source, /threadId: providerTarget\.threadId/u);
});

test("live sidebar state subscribes below the Workbench root", async () => {
  const workbenchSource = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  const sidebarSource = await readFile(new URL("./WorkbenchThreadSidebar.tsx", import.meta.url), "utf8");
  const clientSource = await readFile(new URL("../../lib/WorkbenchClient.ts", import.meta.url), "utf8");
  assert.match(workbenchSource, /onThreadSidebarStoreReady/u);
  assert.match(workbenchSource, /<WorkbenchThreadSidebar/u);
  assert.doesNotMatch(workbenchSource, /explorer\.threadSidebar/u);
  assert.match(sidebarSource, /useSyncExternalStore/u);
  assert.match(sidebarSource, /store\?\.subscribe/u);
  assert.match(clientSource, /onThreadSidebarStoreReady\?\.\(threadSidebarClient\)/u);
  assert.doesNotMatch(clientSource, /threadSidebar: threadSidebarSnapshot/u);
});

test("thread context actions group priority checkboxes and canonical status radios", async () => {
  const sidebarSource = await readFile(new URL("./WorkbenchThreadSidebar.tsx", import.meta.url), "utf8");
  const openIndex = sidebarSource.indexOf('id: "open"');
  const settleIndex = sidebarSource.indexOf('id: "settle"');
  const copyIndex = sidebarSource.indexOf('id: "copy-id"');
  const priorityIndex = sidebarSource.indexOf('id: "priority"');
  const statusIndex = sidebarSource.indexOf('id: "status"');
  const archiveIndex = sidebarSource.indexOf('id: "archive"');
  assert.ok(openIndex >= 0 && settleIndex > openIndex && copyIndex > settleIndex);
  assert.ok(priorityIndex > copyIndex && statusIndex > priorityIndex && archiveIndex > statusIndex);
  assert.match(sidebarSource, /presentation: "independent"/u);
  assert.match(sidebarSource, /presentation: "connected"/u);
  assert.match(sidebarSource, /method: "workbench\/thread-state\/status\/set"/u);
  assert.match(sidebarSource, /label: "Needs attention"/u);
  assert.match(sidebarSource, /label: "Completed"/u);
  assert.match(sidebarSource, /label: "Stopped"/u);
  assert.match(sidebarSource, /tone: "needs-attention"/u);
  assert.match(sidebarSource, /tone: "completed"/u);
  assert.match(sidebarSource, /tone: "stopped"/u);
  assert.match(sidebarSource, /status === "stopped" && thread/u);
  assert.match(sidebarSource, /void stopThread\(thread\)/u);
  assert.match(sidebarSource, /checked: pinned/u);
  assert.match(sidebarSource, /checked: snoozed/u);
  assert.match(sidebarSource, /workbench\/thread-state\/draft\/pin\/set/u);
  assert.match(sidebarSource, /workbench\/thread-state\/draft\/snooze\/set/u);
  assert.match(sidebarSource, /disabled: entry\.entryKind !== "draft" && entry\.lifecycle\.settled/u);
  assert.doesNotMatch(sidebarSource, /if \(entry\.entryKind !== "draft"\) \{\s*const snoozed/u);
  assert.match(sidebarSource, /label: snoozed \? "Wake" : "Snooze thread"/u);
  assert.match(sidebarSource, /action === "complete"[\s\S]*?"status\/set", "completed"/u);
  assert.match(sidebarSource, /action === "wake"[\s\S]*?"snooze\/set", false/u);
  assert.doesNotMatch(sidebarSource, /Unsnooze thread/u);
  assert.doesNotMatch(sidebarSource, /Mark as read|markThreadSeen|label: "Stop thread"|id: "stop"/u);
});

test("jit project bootstrap exposes available slices before unrelated hydration", async () => {
  const workbenchSource = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  const sidebarSource = await readFile(new URL("./WorkbenchThreadSidebar.tsx", import.meta.url), "utf8");
  const clientSource = await readFile(new URL("../../lib/WorkbenchClient.ts", import.meta.url), "utf8");
  const storeReadyIndex = clientSource.indexOf("workbenchBindings.onThreadSidebarStoreReady?.(threadSidebarClient)");
  const initialRouteHydrationIndex = clientSource.indexOf("await applyRoute(activeRoute);");
  const beginSelectionIndex = clientSource.indexOf("projectClient.beginProjectSelection(route.projectId)");
  const openObservationIndex = clientSource.indexOf("threadSidebarClient.open(route.projectId)");

  assert.notEqual(storeReadyIndex, -1);
  assert.notEqual(initialRouteHydrationIndex, -1);
  assert.ok(storeReadyIndex < initialRouteHydrationIndex);
  assert.notEqual(beginSelectionIndex, -1);
  assert.notEqual(openObservationIndex, -1);
  assert.ok(beginSelectionIndex < openObservationIndex);
  assert.doesNotMatch(clientSource, /selectProjectStrict\(route\.projectId\)/u);
  assert.doesNotMatch(sidebarSource, /isProjectLoading|isThreadsLoading|threadsError/u);
  assert.match(sidebarSource, /snapshot\.freshness === "loading" && snapshot\.entries\.length === 0/u);
  assert.match(workbenchSource, /const isProjectIdentityLoading =/u);
  assert.match(workbenchSource, /const isProjectTreeLoading =/u);
  assert.doesNotMatch(workbenchSource, /isSidebarThreadsLoading|explorer\.threadSidebar/u);
  assert.match(clientSource, /emitRateLimitsChange\(\);\s*await applyRoute\(activeRoute\);/u);
  assert.doesNotMatch(clientSource, /emitRateLimitsChange\(\);\s*await draftStore\.hydratePersistedDrafts\(\);/u);
});

test("blank thread routes render their private draft and preserve one view instance through promotion", async () => {
  const workbenchSource = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  const threadViewSource = await readFile(new URL("./thread-view/ThreadView.tsx", import.meta.url), "utf8");
  const clientSource = await readFile(new URL("../lib/WorkbenchClient.ts", import.meta.url), "utf8");
  assert.match(workbenchSource, /isThreadOwnedByEffectiveRoute\(currentThread\)/u);
  assert.match(workbenchSource, /isWorkbenchRouteOwnerOfThread\(effectiveThreadRoute, getThreadViewInstanceKey\(thread\)\)/u);
  assert.doesNotMatch(workbenchSource, /currentThread\?\.id === effectiveThreadId/u);
  assert.match(workbenchSource, /key=\{`\$\{activeProjectId\}:\$\{threadViewInstanceKey\}`\}/u);
  assert.match(workbenchSource, /viewInstanceKey=\{threadViewInstanceKey\}/u);
  assert.match(threadViewSource, /\[projectId, scrollAnchorController, viewInstanceKey\]/u);
  assert.doesNotMatch(threadViewSource, /\[projectId, scrollAnchorController, thread\.id\]/u);
  assert.match(clientSource, /onThreadCreated: \(createdThread\) => \{[\s\S]*?applyThreadPayloadToCurrentView\(createdThread, "Connecting thread\."\)/u);
  assert.match(clientSource, /sessionState\.currentThreadId === createdThreadId[\s\S]*?applyThreadPayloadToCurrentView\(thread\)/u);
});
