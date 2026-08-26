/*
 * Exports:
 * - No production exports; static regression checks cover thread accessibility, grouped context actions, accepted settlement routing, lifecycle ownership, and agent tabs. Keywords: explorer, sidebar, context menu, tablist, keyboard, settlement.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("threads render one keyboard-navigable tablist with settled rows and custom drag ownership", async () => {
  const [draggableSource, listSource, itemSource, sidebarSource, workbenchSource] = await Promise.all([
    readFile(new URL("./drag/Draggable.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchThreadList.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchThreadListItem.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchThreadSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../workbench.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(listSource, /role="tablist"/u);
  assert.match(listSource, /role="tab"/u);
  assert.match(listSource, /event\.key === "ArrowDown"/u);
  assert.match(listSource, /event\.key === "ArrowUp"/u);
  assert.match(listSource, /event\.key === "Home"/u);
  assert.match(listSource, /event\.key === "End"/u);
  assert.match(listSource, /summary="Settled threads"/u);
  assert.match(listSource, /WORKBENCH_THREAD_ORDER_DROP_TARGET_ID/u);
  assert.match(listSource, /THREAD_ORDER_DROP_RANGE = \{ x: 24, y: 100_000 \}/u);
  assert.match(listSource, /range=\{THREAD_ORDER_DROP_RANGE\}/u);
  assert.doesNotMatch(listSource, /payload\.sourceKey !== key/u);
  assert.match(listSource, /<DropTargetBoundary/u);
  assert.match(draggableSource, /draggable: false/u);
  assert.match(draggableSource, /onDragStart[\s\S]*?event\.preventDefault\(\)/u);
  assert.match(listSource, /draggable=\{draggable\}/u);
  assert.match(itemSource, /<a[\s\S]*?draggable=\{draggable\}/u);
  assert.match(workbenchSource, /isDragActive=\{Boolean\(activeWorkbenchDrag\)\}/u);
  assert.match(sidebarSource, /<WorkbenchThreadList[\s\S]*?isDragActive=\{isDragActive\}/u);
  assert.match(listSource, /<WorkbenchThreadListItem[\s\S]*?isDragActive=\{isDragActive\}/u);
  assert.match(itemSource, /<WorkbenchTooltip[\s\S]*?enabled=\{showTooltip && !isDragActive\}[\s\S]*?<a/u);
  assert.match(itemSource, /More actions for \$\{entry\.title\}/u);
  assert.match(itemSource, /isDragActive \? "" : " group-hover\/thread-row:opacity-100 group-focus-within\/thread-row:opacity-100"/u);
  assert.match(listSource, /<WorkbenchThreadListItem[\s\S]*?href=\{getThreadHref\(target\)\}[\s\S]*?role="tab"/u);
  assert.match(itemSource, /<a[\s\S]*?href=\{href\}[\s\S]*?role=\{role\}/u);
  assert.match(listSource, /href=\{getThreadHref\(\{ kind: "new" \}\)\}/u);
  assert.match(itemSource, /event\.preventDefault\(\);[\s\S]*?onActivate\(target\)/u);
  assert.match(itemSource, /canComplete = entry\.entryKind === "thread" && !isWorkbenchThreadStatusProviderOwned\(entry\.lifecycle\)/u);
  assert.match(itemSource, /canShiftSettle && isShiftPressed \? "settle" : baseAction/u);
  assert.match(itemSource, /event\.shiftKey \|\| event\.detail > 1/u);
  assert.match(itemSource, /actionLabel === "restore"|action === "restore"/u);
  assert.match(listSource, /attentionLabelsByThreadId/u);
});

test("agent tabs keep a persistent settled toggle and durable thread routing", async () => {
  const source = await readFile(new URL("./thread-view/ThreadAgentTabs.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-expanded=\{isSettledSubagentsVisible\}/u);
  assert.match(source, /\? "Hide" : "Show"\} settled subagents/u);
  assert.match(source, /Restore subagent/u);
  assert.match(source, /Settle subagent/u);
  assert.match(source, /href=\{getThreadHref\(tab\.id\)\}/u);
  assert.match(source, /href=\{getThreadHref\(mainThreadId\)\}/u);
  assert.match(source, /handleThreadLinkClick/u);
  assert.match(source, /threadSidebarStore\?\.getSnapshot\(\)\?\.entries\.find/u);
  assert.match(source, /candidate\.identity\.harness === mainThreadHarness/u);
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

test("thread views reuse the sidebar's in-app thread navigation owner", async () => {
  const source = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  assert.match(source, /<ThreadView[\s\S]*?onOpenThread=\{openThreadFromExplorer\}/u);
  assert.match(source, /<WorkbenchThreadPanel[\s\S]*?onOpenThread=\{openThreadFromExplorer\}/u);
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

test("reload dirt stays inside the sidebar scroll owner without idle browser polling", async () => {
  const [workbenchSource, reloadSource] = await Promise.all([
    readFile(new URL("../workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("./ReloadNecessary.tsx", import.meta.url), "utf8"),
  ]);
  const sidebarBoundaryStart = workbenchSource.indexOf("<DropTargetBoundary");
  const reloadSurface = workbenchSource.indexOf("<ReloadNecessary", sidebarBoundaryStart);
  const sidebarBoundaryEnd = workbenchSource.indexOf("</DropTargetBoundary>", sidebarBoundaryStart);
  assert.ok(sidebarBoundaryStart >= 0);
  assert.ok(reloadSurface > sidebarBoundaryStart);
  assert.ok(reloadSurface < sidebarBoundaryEnd);
  assert.match(reloadSource, /useSyncExternalStore\(store\?\.subscribe/u);
  assert.match(reloadSource, /dirt\.dirtyScopes\.map/u);
  assert.match(reloadSource, /holdToConfirmMs=\{getReloadScopeHoldMs\(scope\)\}/u);
  assert.match(reloadSource, /holdToConfirmMs=\{getReloadAllHoldMs\(dirt\.dirtyScopes\)\}/u);
  assert.doesNotMatch(reloadSource, /scope\.description/u);
  assert.doesNotMatch(reloadSource, /setInterval|orchestrator\/dirt/u);
  assert.doesNotMatch(workbenchSource, /\/api\/orchestrator\/dirt/u);
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
  assert.match(sidebarSource, /tone: getNeedsAttentionThreadStatusTone\(entry\.gitArc\?\.phase === "active"\)/u);
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
  const clientSource = await readFile(new URL("../../lib/WorkbenchClient.ts", import.meta.url), "utf8");
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

test("successful settlement leaves the still-selected thread for a fresh draft", async () => {
  const workbenchSource = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  const sidebarSource = await readFile(new URL("./WorkbenchThreadSidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebarSource, /const accepted = await controls\.updateThreadStateWithAcceptance\(request\);[\s\S]*?method === "settle" && accepted[\s\S]*?onThreadSettled/u);
  assert.match(sidebarSource, /entry\.lifecycle\.settled \|\| isWorkbenchThreadSettlementAvailable\(entry\)/u);
  assert.match(workbenchSource, /currentRouteRef\.current[\s\S]*?isWorkbenchThreadTargetSelected\(settledTarget, currentRoute\.threadTarget\)[\s\S]*?createThreadRoute\(currentRoute\.projectId, \{ kind: "new" \}\)/u);
  assert.match(workbenchSource, /onThreadSettled=\{handleThreadSettled\}/u);
});

test("active saved drafts hydrate composer input from the subscribed sidebar draft", async () => {
  const source = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  assert.match(source, /route\.threadTarget\?\.kind === "draft"[\s\S]*?getSidebarDraftComposerInput\(activeSidebarDraft\)/u);
  assert.doesNotMatch(source, /useMemo\(\(\) => getThreadComposerDraftForTarget\(/u);
});
