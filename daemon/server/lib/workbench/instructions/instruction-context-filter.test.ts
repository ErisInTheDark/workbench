/* No production exports. Tests protect the selector owner's final instruction filtering behavior. */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  filterWorkbenchInstructionContent,
  formatWorkbenchInstructionFilterWarning,
  stripWorkbenchInstructionHtmlComments,
  type WorkbenchInstructionFilterWarning,
} from "./instruction-context-filter";
import type { RenderedInstructionContent } from "./instruction-file-generation";

function filter(
  value: string,
  harness: "codex" | "copilot" | "opencode" = "codex",
  shell: "pwsh" | "bash" = "pwsh",
  available = new Set(["thread-recall"]),
  sourceSections?: readonly RenderedInstructionContent[],
) {
  const warnings: WorkbenchInstructionFilterWarning[] = [];
  return {
    output: filterWorkbenchInstructionContent(value, {
      available,
      field: "test",
      harness,
      onWarning: (warning) => warnings.push(warning),
      shell,
      sourceSections,
    }),
    warnings,
  };
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
  assert.equal(stripWorkbenchInstructionHtmlComments(value), `beforeafter${"\n".repeat(6)}kept`);
  assert.equal(result.output, `beforeafter${"\n".repeat(6)}kept`);
  assert.deepEqual(result.warnings, []);
});

test("fenced html comment examples remain literal", () => {
  const value = "```md\n<!-- backtick example -->\n```\n~~~md\n<!-- tilde example -->\n~~~";
  assert.equal(stripWorkbenchInstructionHtmlComments(value), value);
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

test("unknown availability reports the active source file and exact value span", () => {
  const sourceContent = "heading\n<available:thread-status>\nbody";
  const content = `wrapper\n${sourceContent}\nafter`;
  const result = filter(content, "codex", "pwsh", new Set(["thread-recall"]), [{
    content: sourceContent,
    sources: [{
      absolutePath: "C:\\library\\wb\\mechanics\\thread-status.md",
      outputEnd: sourceContent.length,
      outputStart: 0,
      sourceContent,
      sourceStart: 0,
    }],
  }]);

  assert.deepEqual(result.warnings[0], {
    column: "<available:".length + 1,
    field: "test",
    length: "thread-status".length,
    line: 2,
    message: "Unable to check availability of thread-status",
    path: "C:\\library\\wb\\mechanics\\thread-status.md",
    recovery: "malformed",
    source: "<available:thread-status>",
  });
});

test("warning rendering uses a home-relative path and distinct prefix colours", () => {
  const formatted = formatWorkbenchInstructionFilterWarning({
    column: 12,
    field: "test",
    length: 13,
    line: 2,
    message: "Unable to check availability of thread-status",
    path: path.join(os.homedir(), ".workbench", "wb", "mechanics", "thread-status.md"),
    recovery: "malformed",
    source: "<available:thread-status>",
  });
  const [summary, source, pointer] = formatted.split("\n");

  assert.match(summary ?? "", /^\u001b\[31mINSTR ~\/\.workbench\/wb\/mechanics\/thread-status\.md:2 /u);
  assert.match(source ?? "", /^\u001b\[31mINSTR\u001b\[0m \u001b\[33m2\u001b\[0m <available:thread-status>$/u);
  assert.match(pointer ?? "", /^\u001b\[31mINSTR /u);
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
