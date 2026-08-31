/* No production exports. Tests protect the selector owner's final instruction filtering behavior. */
import assert from "node:assert/strict";
import test from "node:test";
import { filterWorkbenchInstructionContent, type WorkbenchInstructionFilterWarning } from "./instruction-context-filter";

function filter(value: string, harness: "codex" | "copilot" | "opencode" = "codex", shell: "pwsh" | "bash" = "pwsh", available = new Set(["thread-recall"])) {
  const warnings: WorkbenchInstructionFilterWarning[] = [];
  return { output: filterWorkbenchInstructionContent(value, { available, field: "test", harness, onWarning: (warning) => warnings.push(warning), shell }), warnings };
}

test("selectors are conjunctive and control lines never escape", () => {
  const value = "before\n<harness:codex>\n<shell:pwsh>\nkept\n</shell:pwsh>\n</harness:codex>\n<harness:copilot>\nremoved\n</harness:copilot>\nafter";
  assert.equal(filter(value).output, "before\nkept\nafter");
});

test("fenced selector examples remain literal", () => {
  const value = "```md\n<harness:copilot>\nexample\n</harness:copilot>\n```";
  assert.equal(filter(value).output, value);
});

test("html comments are stripped before selector parsing while preserving line breaks", () => {
  const value = "before<!-- inline -->after\n<!--\n<harness:not-real>\nhidden\n</harness:not-real>\n-->\nkept";
  const result = filter(value);
  assert.equal(result.output, `beforeafter${"\n".repeat(6)}kept`);
  assert.deepEqual(result.warnings, []);
});

test("fenced html comment examples remain literal", () => {
  const value = "```md\n<!-- backtick example -->\n```\n~~~md\n<!-- tilde example -->\n~~~";
  assert.equal(filter(value).output, value);
});

test("an unclosed html comment opener remains literal", () => {
  const value = "before\n<!-- unfinished\nafter";
  assert.equal(filter(value).output, value);
});

test("unknown and malformed controls preserve body and warn", () => {
  const result = filter("<available:not-real>\nbody\n</available:not-real>");
  assert.equal(result.output, "body");
  assert.equal(result.warnings.length, 2);
});

test("multi-root availability keeps workspace-only instructions out of single-root prompts", () => {
  const value = "before\n<available:multi-root>\nworkspace arc\n</available:multi-root>\nafter";
  assert.equal(filter(value).output, "before\nafter");
  assert.equal(filter(value, "codex", "pwsh", new Set(["thread-recall", "multi-root"])).output, "before\nworkspace arc\nafter");
});

test("capability selectors use their exact availability", () => {
  const value = [
    "<available:browse-raw>",
    "raw Browse",
    "</available:browse-raw>",
    "<available:long-waits>",
    "wait",
    "</available:long-waits>",
    "<available:thread-refresh>",
    "refresh",
    "</available:thread-refresh>",
  ].join("\n");
  assert.equal(filter(value, "codex", "pwsh", new Set(["browse-raw"])).output, "raw Browse");
  assert.equal(filter(value, "codex", "pwsh", new Set(["long-waits"])).output, "wait");
  assert.equal(filter(value, "codex", "pwsh", new Set(["thread-refresh"])).output, "refresh");
});
