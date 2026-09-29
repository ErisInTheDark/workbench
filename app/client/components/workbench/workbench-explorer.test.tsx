/*
 * Exports:
 * - No production exports; legacy source checks cover explorer wiring. Keywords: explorer, context menu, tablist, keyboard, settlement.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("threads render one keyboard-navigable tablist with settled rows and custom drag ownership", async () => {
  const [draggableSource, listSource, itemSource, sidebarSource] = await Promise.all([
    readFile(new URL("./drag/Draggable.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchThreadList.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchThreadListItem.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchThreadSidebar.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(listSource, /role="tablist"/u);
  assert.match(listSource, /role="tab"/u);
  assert.match(listSource, /event\.key === "ArrowDown"/u);
  assert.match(listSource, /event\.key === "ArrowUp"/u);
  assert.match(listSource, /event\.key === "Home"/u);
  assert.match(listSource, /event\.key === "End"/u);
  assert.match(listSource, /<span>Settled threads<\/span>/u);
  assert.match(listSource, /WORKBENCH_THREAD_ORDER_DROP_TARGET_ID/u);
  assert.match(listSource, /THREAD_ORDER_DROP_RANGE = \{ x: 24, y: 100_000 \}/u);
  assert.match(listSource, /range=\{THREAD_ORDER_DROP_RANGE\}/u);
  assert.doesNotMatch(listSource, /payload\.sourceKey !== key/u);
  assert.match(listSource, /<DropTargetBoundary/u);
  assert.match(draggableSource, /draggable: false/u);
  assert.match(draggableSource, /onDragStart[\s\S]*?event\.preventDefault\(\)/u);
  assert.match(listSource, /draggable=\{draggable/u);
  assert.match(itemSource, /<a[\s\S]*?draggable=\{draggable\}/u);
  assert.match(sidebarSource, /<WorkbenchThreadList/u);
  assert.match(listSource, /projectWorkbenchHomeThreadList/u);
  assert.match(listSource, /<WorkbenchThreadListItem[\s\S]*?isDragActive=\{isDragActive\}/u);
  assert.match(itemSource, /<WorkbenchTooltip[\s\S]*?enabled=\{showTooltip && !isDragActive\}[\s\S]*?<a/u);
  assert.match(itemSource, /More actions for \$\{entry\.title\}/u);
  assert.match(listSource, /<WorkbenchThreadListItem[\s\S]*?href=\{getThreadHref[\s\S]*?role="tab"/u);
  assert.match(itemSource, /<a[\s\S]*?href=\{href\}[\s\S]*?role=\{role\}/u);
  assert.match(listSource, /getThreadHref\(\{ kind: "new" \}/u);
  assert.match(itemSource, /event\.preventDefault\(\);[\s\S]*?onActivate\(target\)/u);
  assert.match(listSource, /attentionLabelsByThreadId/u);
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
  assert.match(source, /<ThreadView[\s\S]*?onOpenThread=\{\(target\) => \{ void openThreadFromExplorer\(target, threadProjectId\); \}\}/u);
  assert.match(source, /<WorkbenchThreadPanel[\s\S]*?onOpenThread=\{openThreadFromExplorer\}/u);
});

test("thread context actions group priority checkboxes and canonical status radios", async () => {
  const sidebarSource = await readFile(new URL("./WorkbenchThreadSidebarActions.tsx", import.meta.url), "utf8");
  assert.match(sidebarSource, /presentation: "independent"/u);
  assert.match(sidebarSource, /presentation: "connected"/u);
  assert.match(sidebarSource, /"status\/set"/u);
  assert.match(sidebarSource, /label: "Needs attention"/u);
  assert.match(sidebarSource, /label: "Completed"/u);
  assert.match(sidebarSource, /label: "Stopped"/u);
  assert.match(sidebarSource, /tone: "completed"/u);
  assert.match(sidebarSource, /tone: "stopped"/u);
  assert.match(sidebarSource, /status === "stopped" && controls/u);
  assert.match(sidebarSource, /getThreadStopIntent\(stopEntry\)/u);
  assert.match(sidebarSource, /checked: pinned/u);
  assert.match(sidebarSource, /checked: snoozed/u);
  assert.match(sidebarSource, /setPresentationDraftPriority\(draftId, \{/u);
  assert.match(sidebarSource, /pinned: method === "pin\/set" \? Boolean\(value\) : entry\.metadata\.pinned/u);
  assert.doesNotMatch(sidebarSource, /if \(entry\.entryKind !== "draft"\) \{\s*const snoozed/u);
  assert.match(sidebarSource, /label: snoozed \? "Wake" : "Snooze thread"/u);
  assert.doesNotMatch(sidebarSource, /Unsnooze thread/u);
  assert.doesNotMatch(sidebarSource, /Mark as read|markThreadSeen|label: "Stop thread"|id: "stop"/u);
});

test("successful settlement leaves the still-selected thread for a fresh draft", async () => {
  const workbenchSource = await readFile(new URL("../workbench.tsx", import.meta.url), "utf8");
  const sidebarSource = await readFile(new URL("./WorkbenchThreadSidebarActions.tsx", import.meta.url), "utf8");
  assert.match(sidebarSource, /const accepted = await controls\.threadAction\(identity\.threadId, intent\);[\s\S]*?method === "settle" && accepted[\s\S]*?onThreadSettled/u);
  assert.match(workbenchSource, /currentRouteRef\.current[\s\S]*?isWorkbenchThreadTargetSelected\(settledTarget, currentRoute\.threadTarget\)[\s\S]*?createThreadRoute\(currentRoute\.projectId, \{ kind: "new" \}\)/u);
  assert.match(workbenchSource, /onThreadSettled=\{handleThreadSettled\}/u);
});

