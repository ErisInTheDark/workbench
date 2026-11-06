/* No production exports. Tests oversized tool results leave real text from both ends and a path, in text and in a shell's own fields. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import Gpt5TextTokens from "../lib/workbench/commands/gpt-5-text-tokens";
import { spillToolResult, TOOL_OUTPUT_PREVIEW_TOKENS, TOOL_OUTPUT_SPILL_TOKENS } from "./workbench-tool-output-spill";

const line = (index: number) => `src/module${index}/file.ts:${index}: const value${index} = compute("item-${index}");\n`;
const big = Array.from({ length: 3_000 }, (_, index) => line(index)).join("");
const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
const savedAt = (saved: string[]) => async (text: string) => { saved.push(text); return { path: "C:/files/output.txt" }; };
const textOf = (result: CallToolResult) => (result.content[0] as { text: string }).text;

test("a result under the limit is untouched and nothing is saved", async () => {
  const saved: string[] = [];
  const result = textResult("short");
  assert.equal(await spillToolResult(result, { save: savedAt(saved) }), result);
  assert.deepEqual(saved, []);
});

test("an oversized result keeps both ends and names a file holding the raw text", async () => {
  const saved: string[] = [];
  const preview = textOf(await spillToolResult(textResult(big), { save: savedAt(saved) }));
  assert.deepEqual(saved, [big]);
  assert.ok(preview.startsWith(line(0)));
  assert.ok(preview.endsWith(line(2_999)));
  assert.match(preview, /omitted [\d,]+ characters\. Full output: C:\/files\/output\.txt/u);
  const { tokens } = Gpt5TextTokens.measure(preview);
  assert.ok(tokens < TOOL_OUTPUT_PREVIEW_TOKENS * 2.2 && tokens < TOOL_OUTPUT_SPILL_TOKENS, `${tokens} tokens`);
});

test("output that is one enormous line still shows text from both ends", async () => {
  const oneLine = `start-${"abc def ".repeat(40_000)}-end`;
  const preview = textOf(await spillToolResult(textResult(oneLine), { save: savedAt([]) }));
  assert.ok(preview.startsWith("start-abc"));
  assert.ok(preview.endsWith("-end"));
  assert.ok(preview.length < 40_000);
});

test("a shell's own fields stay valid and bounded, since code-mode providers read them instead of the text", async () => {
  const result = await spillToolResult({
    ...textResult(`Exit code: 1\nOutput:\n${big}`),
    structuredContent: { cwd: "C:/repo", exitCode: 1, shell: "pwsh", stderr: "failed\n", stdout: big },
  }, { save: savedAt([]) });
  const structured = result.structuredContent as { exitCode: number; stderr: string; stdout: string };
  assert.equal(structured.exitCode, 1);
  assert.equal(structured.stderr, "failed\n");
  assert.ok(structured.stdout.startsWith(line(0)) && structured.stdout.endsWith(line(2_999)));
  assert.match(structured.stdout, /Full output: C:\/files\/output\.txt/u);
  assert.ok(structured.stdout.length < big.length / 2);
});

test("another tool's structured copy would carry the whole output past the preview, so it goes", async () => {
  const result = await spillToolResult({ ...textResult(big), structuredContent: { whole: big } }, { save: savedAt([]) });
  assert.equal(result.structuredContent, undefined);
});

test("a failed save still answers the call with the preview, and says so", async () => {
  const result = await spillToolResult(textResult(big), { save: async () => { throw new Error("disk full"); } });
  assert.equal(result.isError, false);
  assert.match(textOf(result), /could not be saved: disk full/u);
  assert.ok(textOf(result).startsWith(line(0)));
});

test("huge unbroken text spills without a slow count", async () => {
  const unbroken = "x".repeat(2_000_000);
  const before = performance.now();
  assert.match(textOf(await spillToolResult(textResult(unbroken), { save: savedAt([]) })), /Full output/u);
  assert.ok(performance.now() - before < 5_000);
});

test("cuts never leave half a character", async () => {
  const emoji = "😀 ".repeat(30_000);
  const preview = textOf(await spillToolResult(textResult(emoji), { save: savedAt([]) }));
  assert.doesNotMatch(preview, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});
