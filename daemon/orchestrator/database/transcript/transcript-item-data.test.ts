/*
 * Exports: none. Tests protect data fidelity, bounded expansion and disclosure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchProjectedTranscriptItem } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import { expandTranscriptFields, previewTranscriptFields, transcriptItemFields } from "./transcript-item-data";
import type { TranscriptField } from "./transcript-query-contract";

function generic(safeValue: Extract<WorkbenchProjectedTranscriptItem, { type: "generic" }>["safeValue"]): WorkbenchProjectedTranscriptItem {
  return { type: "generic", id: "item", nativeType: "extension", safeValue };
}

test("item fields preserve nested key identity, array order, scalar types and empty values", () => {
  const item = generic({ "a.b": [false, 0, null, "", [], {}, { "0": "numeric key" }], a: { b: true } });
  const fields = transcriptItemFields(item, true);
  const values = fields.filter(field => field.path[0] === "safeValue");
  assert.deepEqual(values, [
    { path: ["safeValue", "a.b", 0], value: false },
    { path: ["safeValue", "a.b", 1], value: 0 },
    { path: ["safeValue", "a.b", 2], value: null },
    { path: ["safeValue", "a.b", 3], value: "" },
    { path: ["safeValue", "a.b", 4], value: [] },
    { path: ["safeValue", "a.b", 5], value: {} },
    { path: ["safeValue", "a.b", 6, "0"], value: "numeric key" },
    { path: ["safeValue", "a", "b"], value: true },
  ]);
  const preview = previewTranscriptFields(values);
  assert.ok(preview.some(field => field.value === false));
  assert.ok(preview.some(field => field.value === 0));
  assert.ok(preview.some(field => field.path[2] === 6));
  assert.ok(preview.every(field => field.value !== null && typeof field.value !== "object"));
});

test("previews mark long strings and expansion recovers every Unicode character across field boundaries", () => {
  const original = `first\n${"\u{1f338}".repeat(16000)}\r\nlast`;
  const fields = transcriptItemFields(generic({ body: original, after: false, empty: [] }), true);
  const preview = previewTranscriptFields(fields);
  const shortened = preview.find(field => field.path.at(-1) === "body")!;
  assert.equal(shortened.length, Array.from(original).length);
  assert.ok(typeof shortened.value === "string" && shortened.value.length < original.length);
  assert.equal(preview.find(field => field.path.at(-1) === "after")?.value, false);
  const expanded: TranscriptField[] = [];
  let position = { index: 0, offset: 0 };
  for (;;) {
    const page = expandTranscriptFields(fields, position.index, position.offset);
    assert.ok(page.fields.length > 0);
    expanded.push(...page.fields);
    if (!page.next) break;
    assert.ok(page.next.index > position.index || page.next.offset > position.offset);
    position = page.next;
  }
  const chunks = expanded.filter(field => field.path.at(-1) === "body");
  assert.equal(chunks.map(field => field.value).join(""), original);
  let offset = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.offset ?? 0, offset);
    offset += Array.from(String(chunk.value)).length;
  }
  assert.deepEqual(expanded.at(-1), fields.at(-1));
});

test("many small fields resume at the next field without loss", () => {
  const fields = transcriptItemFields(generic(Array.from({ length: 130 }, (_, index) => index)), true);
  const result: TranscriptField[] = [];
  let next: { index: number; offset: number } | null = { index: 0, offset: 0 };
  while (next) {
    const page = expandTranscriptFields(fields, next.index, next.offset);
    result.push(...page.fields);
    next = page.next;
  }
  assert.deepEqual(result, fields);
});

test("opaque disclosure is opt-in and inline binary assets remain excluded", () => {
  const item = generic({ payload: "opaque text", asset: "data:image/png;base64,aGVsbG8=" });
  assert.ok(transcriptItemFields(item, false).every(field => field.value !== "opaque text"));
  const expanded = transcriptItemFields(item, true);
  assert.ok(expanded.some(field => field.value === "opaque text"));
  assert.ok(expanded.every(field => field.value !== "data:image/png;base64,aGVsbG8="));
});
