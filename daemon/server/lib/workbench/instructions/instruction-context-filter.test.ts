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
  model: string | null = "gpt-6-astra",
  sourceSections?: readonly RenderedInstructionContent[],
) {
  const warnings: WorkbenchInstructionFilterWarning[] = [];
  return {
    output: filterWorkbenchInstructionContent(value, {
      available,
      field: "test",
      harness,
      model,
      onWarning: (warning) => warnings.push(warning),
      shell,
      sourceSections,
    }),
    warnings,
  };
}

test("selectors are conjunctive and control lines never escape", () => {
  const value = "before\n<harness:codex>\n<model:gpt-6-astra>\n<shell:pwsh>\nkept\n</shell:pwsh>\n</model:gpt-6-astra>\n</harness:codex>\n<model:gpt-5>\nremoved\n</model:gpt-5>\n<harness:copilot>\nremoved\n</harness:copilot>\nafter";
  assert.equal(filter(value).output, "before\nkept\nafter");
});

test("adjacent inline harness selectors choose one branch and retain shared text", () => {
  const value = "- <harness:codex>Use Codex search.</harness:codex><harness:opencode>Use OpenCode search.</harness:opencode> Pass arguments separately.";
  assert.equal(filter(value).output, "- Use Codex search. Pass arguments separately.");
  assert.equal(filter(value, "opencode").output, "- Use OpenCode search. Pass arguments separately.");
  assert.deepEqual(filter(value).warnings, []);
});

test("inline selectors work for every axis and compose with standalone blocks", () => {
  const value = [
    "<harness:codex>",
    "start <role:agent>agent</role:agent><role:voice-to-text>voice</role:voice-to-text>",
    "<model:gpt-6-astra>exact</model:gpt-6-astra>",
    '<model matches="^gpt-">family</model matches="^gpt-">',
    "<shell:pwsh>powershell</shell:pwsh>",
    "<available:thread-recall>recall</available:thread-recall>",
    "</harness:codex>",
  ].join("\n");
  assert.equal(filter(value).output, "start agent\nexact\nfamily\npowershell\nrecall");
  assert.equal(filter(value, "codex", "bash", new Set(), "gpt-6-preview").output, "start agent\nfamily");
  assert.equal(filter(value, "opencode").output, "");

  const warnings: WorkbenchInstructionFilterWarning[] = [];
  const voice = filterWorkbenchInstructionContent(value, {
    available: new Set(["thread-recall"]), field: "test", harness: "codex",
    model: "gpt-6-astra", onWarning: warning => warnings.push(warning),
    role: "voice-to-text", shell: "pwsh",
  });
  assert.equal(voice, "start voice\nexact\nfamily\npowershell\nrecall");
  assert.deepEqual(warnings, []);
});

test("inline selectors stay literal in Markdown code and comments cannot activate them", () => {
  const value = [
    "before `<harness:opencode>literal</harness:opencode>` after",
    "```md",
    "<harness:opencode>fenced</harness:opencode>",
    "```",
    "keep<!-- <harness:opencode>hidden</harness:opencode> -->going",
  ].join("\n");
  const result = filter(value);
  assert.equal(result.output, [
    "before `<harness:opencode>literal</harness:opencode>` after",
    "```md",
    "<harness:opencode>fenced</harness:opencode>",
    "```",
    "keepgoing",
  ].join("\n"));
  assert.deepEqual(result.warnings, []);
});

test("inline malformed and crossing selectors preserve body and report the affected column", () => {
  const malformed = filter("prefix <available:not-real>body</available:not-real> suffix");
  assert.equal(malformed.output, "prefix body suffix");
  assert.deepEqual(malformed.warnings.map(warning => warning.recovery), ["malformed", "malformed"]);
  assert.equal(malformed.warnings[0]?.column, "prefix <available:".length + 1);

  const crossed = filter("<harness:codex><model:gpt-6-astra>body</harness:codex></model:gpt-6-astra>");
  assert.equal(crossed.output, "body");
  assert.deepEqual(crossed.warnings.map(warning => warning.recovery), ["crossed"]);

  const unclosed = filter("prefix <harness:opencode>body");
  assert.equal(unclosed.output, "prefix body");
  assert.deepEqual(unclosed.warnings.map(warning => warning.recovery), ["unclosed"]);
  assert.equal(unclosed.warnings[0]?.column, "prefix <harness:".length + 1);
});

test("trusted voice role excludes agent guidance and composes with other selectors", () => {
  const source = "<role:agent>\nordinary\n</role:agent>\n<role:voice-to-text>\n<harness:codex>\nvoice\n</harness:codex>\n</role:voice-to-text>";
  const warnings: WorkbenchInstructionFilterWarning[] = [];
  const context = {
    available: new Set<string>(), field: "pack", harness: "codex" as const,
    model: null, shell: "pwsh" as const,
    onWarning: (warning: WorkbenchInstructionFilterWarning) => warnings.push(warning),
    role: "voice-to-text" as const,
  };
  assert.equal(filterWorkbenchInstructionContent(source, context), "voice");
  assert.equal(filter(source).output, "ordinary");
  assert.deepEqual(warnings, []);
  const example = "```md\n<role:agent>\nliteral\n</role:agent>\n```";
  assert.equal(filterWorkbenchInstructionContent(example, context), example);
});

test("model selectors require the exact configured model", () => {
  const value = "<model:gpt-6-astra>\nastra only\n</model:gpt-6-astra>";
  assert.equal(filter(value).output, "astra only");
  assert.equal(filter(value, "codex", "pwsh", new Set(), "gpt-6-astra-preview").output, "");
  assert.equal(filter(value, "codex", "pwsh", new Set(), null).output, "");
});

test("regex model selectors match configured slugs alongside exact and nested selectors", () => {
  const value = [
    "before",
    '<model matches="^gpt-">',
    "<harness:codex>",
    "gpt family",
    "</harness:codex>",
    '</model matches="^gpt-">',
    "<model:gpt-6-astra>",
    "exact",
    "</model:gpt-6-astra>",
    "after",
  ].join("\n");
  assert.equal(filter(value).output, "before\ngpt family\nexact\nafter");
  assert.equal(filter(value, "codex", "pwsh", new Set(), "gpt-6-preview").output, "before\ngpt family\nafter");
  assert.equal(filter(value, "codex", "pwsh", new Set(), "other-gpt-6").output, "before\nafter");
  assert.equal(filter(value, "opencode").output, "before\nexact\nafter");
  assert.equal(filter(value, "codex", "pwsh", new Set(), null).output, "before\nafter");
});

test("regex model selector examples stay literal and invalid patterns preserve the body with warnings", () => {
  const example = '```md\n<model matches="^gpt-">\nexample\n</model matches="^gpt-">\n```';
  assert.equal(filter(example).output, example);

  const invalid = '<model matches="[">\nbody\n</model matches="[">';
  const result = filter(`before\n${invalid}\nafter`);
  assert.equal(result.output, "before\nbody\nafter");
  assert.equal(result.warnings.length, 2);
  assert.equal(result.warnings[0]?.recovery, "malformed");
});

test("regex model selector closing patterns must match their opener", () => {
  const value = '<model matches="^gpt-">\nbody\n</model matches="^claude-">';
  const result = filter(value);
  assert.equal(result.output, "body");
  assert.deepEqual(result.warnings.map((warning) => warning.recovery), ["unmatched", "unclosed"]);
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

  const malformedModel = filter("<model:gpt 6>\nmodel body\n</model:gpt 6>");
  assert.equal(malformedModel.output, "model body");
  assert.equal(malformedModel.warnings.length, 2);
});

test("unknown availability reports the active source file and exact value span", () => {
  const sourceContent = "heading\n<available:thread-status>\nbody";
  const content = `wrapper\n${sourceContent}\nafter`;
  const result = filter(content, "codex", "pwsh", new Set(["thread-recall"]), "gpt-6-astra", [{
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
