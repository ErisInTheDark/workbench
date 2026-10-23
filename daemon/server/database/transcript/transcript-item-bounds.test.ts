/*
 * No production exports. Tests protect the per-string bound on admitted item text, and that the stored-text release
 * repairs older rows to exactly what settlement now keeps.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import { boundTranscriptItem, MAX_TRANSCRIPT_ITEM_STRING_CHARS } from "./transcript-item-bounds.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import type { WorkbenchTranscriptAtomicObservation } from "./workbench-transcript-types.ts";

function toolResult(text: string, id = "call"): ThreadItem {
  return {
    id, type: "mcpToolCall", server: "wb", tool: "rg", status: "completed", arguments: { args: ["x"] },
    appContext: null, pluginId: null, readOnlyHint: true,
    result: { content: [{ type: "text", text }], structuredContent: null, _meta: null }, error: null, durationMs: 1,
  } as unknown as ThreadItem;
}

function resultText(item: ThreadItem | undefined) {
  return item?.type === "mcpToolCall" ? (item.result!.content[0] as { text: string }).text : "";
}

test("an oversized tool result keeps its head and tail with an omission marker", () => {
  const text = `HEAD${"x".repeat(5 * 1024 * 1024)}TAIL`;
  const stored = resultText(boundTranscriptItem(toolResult(text)));
  assert.ok(stored.length < MAX_TRANSCRIPT_ITEM_STRING_CHARS + 200);
  assert.ok(stored.startsWith("HEAD") && stored.endsWith("TAIL"));
  assert.match(stored, /Workbench omitted [\d,]+ characters/u);
});

test("items within the bound and inline images pass through as the same object", () => {
  const small = toolResult("fine");
  assert.equal(boundTranscriptItem(small), small);
  const image = toolResult(`data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`);
  assert.equal(boundTranscriptItem(image), image);
});

test("the stored-text release repairs older oversized results to exactly what settlement now keeps", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database, { targetVersion: databaseReleases.boundedStoredToolText.version - 1 });
    const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread");
    const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn");
    const huge = toolResult(`HEAD${"x".repeat(3 * 1024 * 1024)}TAIL`, "huge");
    const small = toolResult("fine", "small");
    const item = (value: ThreadItem): WorkbenchTranscriptAtomicObservation => ({
      kind: "item", threadId, turnId, lifecycle: "completed", observedAt: 3, item: value,
    });
    // Rows written before the bound existed went straight to the repository, unbounded.
    new WorkbenchTranscriptRepository(database).settle([
      { kind: "thread", threadId, projectId: testProjectIds.project, projectRoot: "C:/project", title: "Thread",
        createdAt: 1, updatedAt: 1, activityAt: 1 },
      { kind: "turn", threadId, turnId, turnIndex: 0, harnessId: "codex", nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("native"),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"), state: "completed",
        createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1 },
      item(huge), item(small),
    ]);

    installWorkbenchDatabaseSchema(database);
    const projected = projectWorkbenchTranscript(new WorkbenchTranscriptRepository(database).read({ threadId, turnLimit: 1 })!);
    assert.ok(projected.success);
    // Settlement assigns public item ids, so the results are told apart by their text.
    const texts = projected.data.turns[0]!.items.map(resultText);
    const repaired = texts.find(text => text.startsWith("HEAD")) ?? "";
    const settled = resultText(boundTranscriptItem(huge));
    // Compared by summary, so a failure never prints megabytes.
    const summary = (text: string) => ({ length: text.length, marker: /\[Workbench omitted [\d,]+ characters[^\]]*\]/u.exec(text)?.[0] });
    assert.deepEqual(summary(repaired), summary(settled));
    assert.ok(repaired === settled, "repaired text must equal the settlement bound character for character");
    assert.ok(texts.includes("fine"), "results within the bound are left alone");
  } finally {
    database.close();
  }
});
