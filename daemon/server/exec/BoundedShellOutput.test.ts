/* Exports: none. Tests protect that huge command output keeps both ends, says what it dropped, and stays valid text. */
import assert from "node:assert/strict";
import { test } from "node:test";

import BoundedShellOutput from "./BoundedShellOutput";

const MEBIBYTE = 1024 * 1024;

function capture(chunks: readonly Buffer[]) {
  const output = new BoundedShellOutput();
  for (const chunk of chunks) output.write("stdout", chunk);
  return output.read().stdout;
}

test("output within the budget stays byte for byte, whatever its chunking", () => {
  const whole = "héllo wörld\n".repeat(70_000);
  const bytes = Buffer.from(whole);
  assert.ok(bytes.byteLength < MEBIBYTE && bytes.byteLength > MEBIBYTE / 2);
  const chunks = Array.from({ length: Math.ceil(bytes.byteLength / 7_001) }, (_, index) => bytes.subarray(index * 7_001, (index + 1) * 7_001));
  const text = capture(chunks);
  assert.ok(text === whole, "text changed");
  assert.equal(BoundedShellOutput.hasGap(text), false);
});

test("output past the budget keeps its start and end, and counts exactly what it dropped", () => {
  const text = capture([Buffer.from("first line\n"), Buffer.alloc(3 * MEBIBYTE, "x"), Buffer.from("\nthe summary")]);
  assert.ok(text.startsWith("first line\n"));
  assert.ok(text.endsWith("\nthe summary"));
  const omitted = /\[Workbench omitted ([\d,]+) bytes/u.exec(text);
  assert.equal(omitted?.[1], (3 * MEBIBYTE + "first line\n\nthe summary".length - MEBIBYTE).toLocaleString("en-US"));
  assert.equal(BoundedShellOutput.hasGap(text), true);
  assert.ok(Buffer.byteLength(text) < 1.1 * MEBIBYTE);
});

test("a cut through a multi-byte character leaves no broken text at either end", () => {
  const text = capture([Buffer.from("語".repeat(MEBIBYTE))]);
  assert.ok(!text.includes("�"), "broken character at a cut");
  assert.equal(BoundedShellOutput.hasGap(text), true);
});

test("a flood on one stream leaves the other whole", () => {
  const output = new BoundedShellOutput();
  output.write("stdout", Buffer.from("the result"));
  output.write("stderr", Buffer.alloc(3 * MEBIBYTE, "!"));
  assert.ok(output.read().stdout === "the result");
});
