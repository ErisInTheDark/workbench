/* No production exports. Tests protect bounded wb rg output on minified files and broad searches. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { parseRipgrepArguments } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";
import { RIPGREP_MAX_OUTPUT_CHARS, runRipgrepSearch } from "./ripgrep-search";

async function search(args: string[], files: Record<string, string>) {
  const directory = await WorkbenchTemporaryDirectory.create("wb-rg-search-");
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(directory.path, name), text);
    const parsed = parseRipgrepArguments(["--no-ignore", ...args, "."]);
    assert.equal(parsed.kind, "query");
    if (parsed.kind !== "query") throw new Error("unreachable");
    const result = await runRipgrepSearch({ query: parsed.query, cwd: directory.path, prefetchWarnings: {} });
    assert.equal(result.kind, "output");
    return result.kind === "output" ? result.output : "";
  } finally { await directory.dispose(); }
}

test("a match inside a minified one-line file prints a bounded window around the match", async () => {
  const line = `${"a".repeat(300_000)}NEEDLE${"b".repeat(300_000)}`;
  const output = await search(["NEEDLE"], { "min.json": line });
  assert.ok(output.length < 1_000, `${output.length} chars`);
  assert.match(output, /\[… [\d,]+ chars\] a+NEEDLEb+ \[… [\d,]+ more chars on this line\]/u);
  assert.equal((await search(["-M", "0", "NEEDLE"], { "min.json": line })).length > line.length, true);
});

test("many long matches stop at the fixed output budget even with unlimited results and columns", async () => {
  const lines = Array.from({ length: 300 }, (_, index) => `${index} NEEDLE ${"x".repeat(10_000)}`).join("\n");
  const output = await search(["--max-results", "0", "-M", "0", "NEEDLE"], { "big.txt": lines });
  assert.ok(output.length <= RIPGREP_MAX_OUTPUT_CHARS + 200);
  assert.match(output, /output truncated at 1 MiB/u);
});
