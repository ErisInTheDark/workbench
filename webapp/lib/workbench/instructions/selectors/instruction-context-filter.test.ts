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
