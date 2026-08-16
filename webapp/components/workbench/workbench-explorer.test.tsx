/*
 * Exports:
 * - No production exports; static regression checks cover flat thread-row accessibility, lifecycle styling, and subagent tab controls. Keywords: explorer, sidebar, tablist, keyboard.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("threads render one flat tablist with lifecycle borders and all settled rows inside one disclosure", async () => {
  const source = await readFile(new URL("./workbench-explorer.tsx", import.meta.url), "utf8");
  assert.match(source, /role="tablist"/u);
  assert.match(source, /role="tab"/u);
  assert.match(source, /event\.key === "ArrowDown"/u);
  assert.match(source, /event\.key === "ArrowUp"/u);
  assert.match(source, /event\.key === "Home"/u);
  assert.match(source, /event\.key === "End"/u);
  assert.match(source, /aria-label=\{`Actions for/u);
  assert.match(source, /summary="Settled threads"/u);
  assert.match(source, /settledEntries\.map\(renderEntry\)/u);
  assert.doesNotMatch(source, /pinnedSettledEntries/u);
  assert.doesNotMatch(source, /<h3/u);
  assert.match(source, /grid-cols-\[auto_minmax\(0,1fr\)_auto_auto\]/u);
  assert.match(source, /<rect/u);
  assert.match(source, /rx="12\.8"/u);
  assert.match(source, /fill="color-mix\(in srgb, var\(--text\) 4%, transparent\)"/u);
  assert.match(source, /stroke="currentColor"/u);
  assert.match(source, /strokeDasharray=\{hasDashedBorder \? "6 4" : undefined\}/u);
  assert.match(source, /transition-opacity duration-75 ease-out/u);
  assert.match(source, /group-hover\/thread-row:opacity-100 group-focus-within\/thread-row:opacity-100/u);
  assert.doesNotMatch(source, /repeating-linear-gradient/u);
  assert.match(source, /hasDashedLifecycleBorder/u);
  assert.match(source, /hover:text-text focus-visible:flex focus-visible:text-text/u);
  assert.match(source, /aria-label=\{actionLabel\}[\s\S]*?cursor-pointer/u);
  assert.doesNotMatch(source, /aria-label=\{actionLabel\}[\s\S]*?hover:bg-/u);
  assert.match(source, /<a[\s\S]*?href=\{getThreadHref\(target\)\}[\s\S]*?role="tab"/u);
  assert.match(source, /href=\{getThreadHref\(\{ kind: "new" \}\)\}/u);
  assert.match(source, /event\.preventDefault\(\);[\s\S]*?onOpenThread\(target\)/u);
  assert.doesNotMatch(source, /Retry draft save|onRetryDraft/u);
  assert.match(source, /className="mt-1"/u);
  assert.doesNotMatch(source, /summaryClassName="px-2/u);
  assert.match(source, /actionLabel === "restore"|action === "restore"/u);
  assert.match(source, /attentionLabelsByThreadId/u);
  assert.match(source, /font-semibold text-text/u);
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
  assert.match(source, /relationship\?\.parentThreadId \?\? child\?\.parentThreadId/u);
  assert.match(source, /const handleSelectedThreadChange = useCallback/u);
  assert.match(source, /selectedThreadId=\{effectiveSelectedThreadId\}/u);
  assert.match(source, /onSelectedThreadChange=\{handleSelectedThreadChange\}/u);
  assert.match(source, /kind: "subagent"/u);
  assert.match(source, /parentThreadId,/u);
  assert.match(source, /threadId: providerTarget\.threadId/u);
});
