/* No production exports. Tests protect the selector owner's final instruction filtering behavior, including `<else>` fallbacks. */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  filterWorkbenchInstructionContent,
  formatWorkbenchInstructionFilterWarning,
  stripWorkbenchInstructionHtmlComments,
  type WorkbenchInstructionFilterWarning,
  type WorkbenchInstructionSetting,
  type WorkbenchInstructionWorkspaceFact,
} from "./instruction-context-filter";
import type { RenderedInstructionContent } from "./instruction-file-generation";
import { resolveWorkbenchInstructionToolReference } from "./instruction-tool-reference";

function filter(
  value: string,
  harness: "claude" | "codex" | "copilot" | "opencode" = "codex",
  shell: "pwsh" | "bash" = "pwsh",
  workspace: ReadonlySet<WorkbenchInstructionWorkspaceFact> = new Set(["project"]),
  model: string | null = "gpt-6-astra",
  sourceSections?: readonly RenderedInstructionContent[],
  settings: ReadonlySet<WorkbenchInstructionSetting> = new Set(),
) {
  const warnings: WorkbenchInstructionFilterWarning[] = [];
  const docs: Array<[string, string]> = [];
  return {
    docs,
    output: filterWorkbenchInstructionContent(value, {
      facts: { settings, workspace },
      field: "test",
      harness,
      model,
      onDocsLine: (tools, line) => docs.push([tools.join(" "), line]),
      onWarning: (warning) => warnings.push(warning),
      // "missing" stands for a tool the caller cannot see, such as a parent-only tool for a subagent.
      resolveTool: id => id === "missing" ? null : `tools.${harness}.${id}`,
      shell,
      sourceSections,
    }),
    warnings,
  };
}

test("tool references expand in ordinary text without disturbing selectors or examples", () => {
  const value = [
    "use <tool id=\"rg\" /> now.",
    "<harness:codex>call <tool id=\"git_arc_release\" />.</harness:codex>",
    "<harness:opencode>skip <tool id=\"git_arc_release\" />.</harness:opencode>",
    "keep `<tool id=\"rg\" />` literal.",
    "```md",
    "<tool id=\"rg\" />",
    "```",
  ].join("\n");
  assert.equal(filter(value).output, [
    "use `tools.codex.rg` now.",
    "call `tools.codex.git_arc_release`.",
    "keep `<tool id=\"rg\" />` literal.",
    "```md",
    "<tool id=\"rg\" />",
    "```",
  ].join("\n"));
  assert.equal(filter(value, "opencode").output.includes("`tools.opencode.rg`"), true);
});

test("invalid tool references stay visible and report their source", () => {
  const result = filter("before <tool id=\"missing\" /> after");
  assert.equal(result.output, "before <tool id=\"missing\" /> after");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.recovery, "malformed");
  assert.equal(result.warnings[0]?.message, "Unknown Workbench tool id");
  assert.deepEqual(filter("<harness:opencode><tool id=\"missing\" /></harness:opencode>").warnings, []);
});

test("registered tool references follow each provider's real MCP route", () => {
  const catalogue = [
    { id: "rg", codeModeEligible: true },
    { id: "git_arc_release", codeModeEligible: false },
  ];
  assert.equal(resolveWorkbenchInstructionToolReference("rg", "codex", catalogue), "tools.mcp__wb__rg");
  assert.equal(resolveWorkbenchInstructionToolReference("git_arc_release", "codex", catalogue), "tools.mcp__wbex__git_arc_release");
  assert.equal(resolveWorkbenchInstructionToolReference("git_arc_release", "opencode", catalogue), "tools.wb.git_arc_release");
  assert.equal(resolveWorkbenchInstructionToolReference("not_a_tool", "codex", catalogue), null);
});

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
    '<model matches="^gpt-">family</model>',
    "<shell:pwsh>powershell</shell:pwsh>",
    "<workspace:project>project</workspace:project>",
    "</harness:codex>",
  ].join("\n");
  assert.equal(filter(value).output, "start agent\nexact\nfamily\npowershell\nproject");
  assert.equal(filter(value, "codex", "bash", new Set(), "gpt-6-preview").output, "start agent\nfamily");
  assert.equal(filter(value, "opencode").output, "");

  const warnings: WorkbenchInstructionFilterWarning[] = [];
  const voice = filterWorkbenchInstructionContent(value, {
    facts: { settings: new Set(), workspace: new Set(["project"]) }, field: "test", harness: "codex",
    model: "gpt-6-astra", onWarning: warning => warnings.push(warning),
    role: "voice-to-text", shell: "pwsh",
  });
  assert.equal(voice, "start voice\nexact\nfamily\npowershell\nproject");
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
  const malformed = filter("prefix <workspace:not-real>body</workspace:not-real> suffix");
  assert.equal(malformed.output, "prefix body suffix");
  assert.deepEqual(malformed.warnings.map(warning => warning.recovery), ["malformed", "malformed"]);
  assert.equal(malformed.warnings[0]?.column, "prefix <workspace:".length + 1);

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
    facts: { settings: new Set<never>(), workspace: new Set<never>() }, field: "pack", harness: "codex" as const,
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
    "</model>",
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
  const example = '```md\n<model matches="^gpt-">\nexample\n</model>\n```';
  assert.equal(filter(example).output, example);

  const invalid = '<model matches="[">\nbody\n</model>';
  const result = filter(`before\n${invalid}\nafter`);
  assert.equal(result.output, "before\nbody\nafter");
  assert.equal(result.warnings.length, 2);
  assert.equal(result.warnings[0]?.recovery, "malformed");
});

test("model matches closes with the bare model tag", () => {
  const value = '<model matches="mimo-2.6-pro">\n## OVERTHINKING IS INCREDIBLY WASTEFUL\nspend less time analysing\n</model>';
  const result = filter(value, "codex", "pwsh", new Set(), "mimo-2.6-pro");
  assert.equal(result.output, "## OVERTHINKING IS INCREDIBLY WASTEFUL\nspend less time analysing");
  assert.deepEqual(result.warnings, []);
});

test("bare model closers follow tag-name identity and nesting", () => {
  const nested = '<model matches="^gpt-">\nouter\n<model matches="^gpt-6">\ninner\n</model>\nleftover\n</model>';
  assert.equal(filter(nested).output, "outer\ninner\nleftover");
  assert.deepEqual(filter(nested).warnings, []);

  const differentName = filter("<model:gpt-6-astra>\nbody\n</model>");
  assert.equal(differentName.output, "body");
  assert.deepEqual(differentName.warnings.map((warning) => warning.recovery), ["unmatched", "unclosed"]);
});

test("attribute-bearing model closers are invalid html and warn", () => {
  const result = filter('<model matches="^gpt-">\nbody\n</model matches="^gpt-">');
  assert.equal(result.output, "body");
  assert.deepEqual(result.warnings.map((warning) => warning.recovery), ["malformed", "unclosed"]);
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
  const result = filter("<setting:not-real>\nbody\n</setting:not-real>");
  assert.equal(result.output, "body");
  assert.equal(result.warnings.length, 2);

  // A user pack written before `available` retired keeps its content and says why instead of leaking tags.
  const retired = filter("<available:thread-recall>\nbody\n</available:thread-recall>");
  assert.equal(retired.output, "body");
  assert.deepEqual(retired.warnings.map(warning => warning.recovery), ["malformed", "malformed"]);
  assert.match(retired.warnings[0]?.message ?? "", /^Retired selector/u);

  const malformedModel = filter("<model:gpt 6>\nmodel body\n</model:gpt 6>");
  assert.equal(malformedModel.output, "model body");
  assert.equal(malformedModel.warnings.length, 2);
});

test("an unknown workspace fact reports the active source file and exact value span", () => {
  const sourceContent = "heading\n<workspace:thread-status>\nbody";
  const content = `wrapper\n${sourceContent}\nafter`;
  const result = filter(content, "codex", "pwsh", new Set(["project"]), "gpt-6-astra", [{
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
    column: "<workspace:".length + 1,
    field: "test",
    length: "thread-status".length,
    line: 2,
    message: "Unknown workspace selector thread-status",
    path: "C:\\library\\wb\\mechanics\\thread-status.md",
    recovery: "malformed",
    source: "<workspace:thread-status>",
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

test("workspace facts keep multi-root and project-only instructions out of other workspaces", () => {
  const value = "before\n<workspace:multi-root>\nworkspace arc\n</workspace:multi-root>\n<workspace:project>\ngit\n</workspace:project>\nafter";
  assert.equal(filter(value).output, "before\ngit\nafter");
  assert.equal(filter(value, "codex", "pwsh", new Set(["project", "multi-root"])).output, "before\nworkspace arc\ngit\nafter");
  assert.equal(filter(value, "codex", "pwsh", new Set(["daemon"])).output, "before\nafter");
});

test("setting selectors follow the caller's enabled local settings", () => {
  const value = "<setting:browse-raw>\nraw Browse\n</setting:browse-raw>";
  assert.equal(filter(value).output, "");
  assert.equal(filter(value, "codex", "pwsh", new Set(["project"]), "gpt-6-astra", undefined, new Set(["browse-raw"])).output, "raw Browse");
});

test("docs regions render when any listed tool is visible and drop out when none are", () => {
  const value = [
    "before",
    "<docs tools=\"missing git_arc_wait\">",
    "wait with <tool id=\"git_arc_wait\" />",
    "</docs>",
    "<docs tools=\"missing\">",
    "hidden <tool id=\"missing\" />",
    "</docs>",
    "after",
  ].join("\n");
  const result = filter(value);
  assert.equal(result.output, "before\nwait with `tools.codex.git_arc_wait`\nafter");
  assert.deepEqual(result.warnings, [], "a hidden tool's own reference inside its hidden docs is not a defect");
});

test("docs regions act as selectors inside wrappers, so else covers callers without the tool", () => {
  const value = "<><docs tools=\"missing\">propose</docs><else>handoff</else></>";
  assert.equal(filter(value).output, "handoff");
  assert.equal(filter("<><docs tools=\"git_arc_propose\">propose</docs><else>handoff</else></>").output, "propose");
});

test("rendered docs lines are attributed to their innermost region, fences included", () => {
  const value = [
    "plain",
    "<docs tools=\"message message_wait\">",
    "shared line",
    "<docs tools=\"message_wait\">",
    "wait line",
    "```js",
    "example",
    "```",
    "</docs>",
    "<harness:opencode>",
    "opencode only",
    "</harness:opencode>",
    "</docs>",
  ].join("\n");
  assert.deepEqual(filter(value).docs, [
    ["message message_wait", "shared line"],
    ["message_wait", "wait line"],
    ["message_wait", "```js"],
    ["message_wait", "example"],
    ["message_wait", "```"],
  ]);
});

test("inline wrapper tags lay out variants across lines with inline parity", () => {
  const wrapped = [
    "paragraph that includes provider-specific instructions like <>",
    "<harness:codex>`tools.mcp__wb__thread_recall`</harness:codex>",
    "<harness:opencode>`tools.wb.thread_recall`</harness:opencode>",
    "</> and it's all inline and bad",
  ].join("\n");
  const inline = "paragraph that includes provider-specific instructions like "
    + "<harness:codex>`tools.mcp__wb__thread_recall`</harness:codex>"
    + "<harness:opencode>`tools.wb.thread_recall`</harness:opencode> and it's all inline and bad";
  assert.equal(filter(wrapped, "codex").output, filter(inline, "codex").output);
  assert.equal(filter(wrapped, "opencode").output, filter(inline, "opencode").output);
  assert.equal(
    filter(wrapped, "codex").output,
    "paragraph that includes provider-specific instructions like `tools.mcp__wb__thread_recall` and it's all inline and bad",
  );
  assert.equal(
    filter(wrapped, "opencode").output,
    "paragraph that includes provider-specific instructions like `tools.wb.thread_recall` and it's all inline and bad",
  );
  assert.equal(
    filter(wrapped, "copilot").output,
    "paragraph that includes provider-specific instructions like and it's all inline and bad",
  );
  assert.deepEqual(filter(wrapped).warnings, []);
});

test("wrapper collapse never touches nested selector interiors", () => {
  const value = [
    "before <>",
    "<harness:codex>keep   these  spaces</harness:codex>",
    "<harness:opencode>",
    "multi   line",
    "  interior",
    "</harness:opencode>",
    "</> after",
  ].join("\n");
  assert.equal(filter(value).output, "before keep   these  spaces after");
  assert.equal(filter(value, "opencode").output, "before \nmulti   line\n  interior\n after");
});

test("wrapper boundaries glue punctuation and respect tight text", () => {
  const glued = ["read one result with <>", "<harness:codex>`expand`</harness:codex>", "</>."].join("\n");
  assert.equal(filter(glued).output, "read one result with `expand`.");
  assert.equal(filter("use<>\n<harness:codex>`x`</harness:codex>\n</>now").output, "use`x`now");
  assert.equal(filter("first\n<>\nplain text\n</>\nlast").output, "first\nplain text\nlast");
  assert.equal(
    filter("<harness:codex>\n<>\ntext\n</>\n</harness:codex>").output,
    filter("<harness:codex>\ntext\n</harness:codex>").output,
  );
});

test("else renders only when no sibling selector in its wrapper rendered", () => {
  const value = [
    "<role:agent>",
    "- Then send <>",
    "<harness:claude>final with exclusively `<wb:end />`</harness:claude>",
    "<else>empty final</else>",
    "</>.",
    "</role:agent>",
  ].join("\n");
  assert.equal(filter(value, "claude").output, "- Then send final with exclusively `<wb:end />`.");
  assert.equal(filter(value, "codex").output, "- Then send empty final.");
  assert.deepEqual(filter(value, "claude").warnings, []);
});

test("else follows its wrapper's sibling selectors in source order", () => {
  const nested = "<><harness:opencode><shell:pwsh>deep</shell:pwsh></harness:opencode><else>fallback</else></>";
  assert.equal(filter(nested).output, "fallback");
  assert.equal(filter(nested, "opencode").output, "deep");
  assert.equal(filter("<><else>first</else><harness:codex>codex</harness:codex></>").output, "firstcodex");
});

test("an else outside a wrapper warns and keeps its content", () => {
  const stray = filter("before <else>kept</else> after");
  assert.equal(stray.output, "before kept after");
  assert.deepEqual(stray.warnings.map((warning) => [warning.recovery, warning.message]), [
    ["malformed", "Instruction else must sit directly inside <>"],
  ]);
});

test("wrapper tags stay literal in code spans and fenced examples", () => {
  const value = ["keep literal `&<>` entity-escaped", "```md", "<>", "</>", "```"].join("\n");
  assert.equal(filter(value).output, value);
  assert.deepEqual(filter(value).warnings, []);
});

test("wrapper-level fences warn and preserve content while variant fences stay verbatim", () => {
  const blocky = filter(["<>", "text", "```md", "keep", "```", "</>"].join("\n"));
  assert.equal(blocky.output, "text\n```md\nkeep\n```");
  assert.deepEqual(blocky.warnings.map((warning) => warning.recovery), ["fenced"]);

  const variant = filter(["<>", "<harness:codex>", "text", "```md", "keep  spaces", "```", "</harness:codex>", "</>"].join("\n"));
  assert.deepEqual(variant.warnings, []);
  assert.equal(variant.output, "\ntext\n```md\nkeep  spaces\n```\n");
});

test("broken wrappers preserve body and report recovery", () => {
  const unclosed = filter("before <>\nkeep\nlines");
  assert.equal(unclosed.output, "before \nkeep\nlines");
  assert.deepEqual(unclosed.warnings.map((warning) => warning.recovery), ["unclosed"]);

  const crossed = filter("<harness:codex><>\nbody\n</harness:codex></>");
  assert.equal(crossed.output, "body");
  assert.deepEqual(crossed.warnings.map((warning) => warning.recovery), ["crossed"]);
});
