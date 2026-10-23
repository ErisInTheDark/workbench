/*
 * No production exports. Protect docs collection across sources for one caller, and repository instructions against tool ids
 * no catalogue serves and selectors that warn at render time.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry";
import { filterWorkbenchInstructionContent, type WorkbenchInstructionFilterWarning } from "./instruction-context-filter";
import { readWorkbenchInstructionSources } from "./instruction-source";
import { collectWorkbenchInstructionToolDocs } from "./instruction-tool-docs";
import {
  listWorkbenchInstructionTools,
  resolveWorkbenchInstructionToolReference,
  selectWorkbenchInstructionTools,
  servesWorkbenchInstructionTool,
} from "./instruction-tool-reference";

const instructionRoot = fileURLToPath(new URL("../../../../../instructions", import.meta.url));
const catalogue = listWorkbenchInstructionTools(listWorkbenchAgentCommands([], "agent", { virtualRepos: true }));
const mcpServed = new Set(catalogue.filter(({ deferred }) => !deferred).map(({ id }) => id));
const allCapabilities = { browseRawCommandsEnabled: true };

test("docs text groups by tools across sources and only counts what this caller would render", () => {
  const docs = collectWorkbenchInstructionToolDocs([
    { relativePath: "a.md", content: "<docs tools=\"message\">\nsend\n<harness:opencode>\nopencode only\n</harness:opencode>\n</docs>" },
    { relativePath: "b.md", content: "<docs tools=\"message\">\nagain\n</docs>\n<docs tools=\"hidden_tool\">\nunseen\n</docs>" },
  ], {
    facts: { workspace: new Set(["project"]) },
    harness: "codex",
    model: null,
    resolveTool: (id) => id === "message" ? "tools.mcp__wb__message" : null,
    servesTool: (id) => id === "message",
    shell: "pwsh",
  });
  assert.deepEqual(docs, [{ text: "send\nagain", tools: ["message"] }]);
});

test("docs regions render for any usable subtool, CLI-only included, but never for a mere name prefix", () => {
  const catalogue = [
    { id: "git_arc_edit_start", codeModeEligible: false, deferred: true },
    { id: "messages", codeModeEligible: true },
  ];
  const output = filterWorkbenchInstructionContent(
    "<docs tools=\"git_arc_edit\">\nedit sessions\n</docs>\n<docs tools=\"message\">\nmessaging\n</docs>",
    {
      facts: { workspace: new Set() },
      field: "family.md",
      harness: "claude",
      model: null,
      onWarning: () => {},
      resolveTool: (id) => resolveWorkbenchInstructionToolReference(id, "claude", catalogue),
      servesTool: (id) => servesWorkbenchInstructionTool(id, catalogue),
      shell: "pwsh",
    },
  );
  assert.equal(output, "edit sessions");
  // CLI-only tools gate docs but have no MCP name a `<tool id>` reference could print.
  assert.equal(resolveWorkbenchInstructionToolReference("git_arc_edit_start", "claude", catalogue), null);
});

test("every docs region and tool reference in repository instructions names a served wb tool", async () => {
  const unknown: string[] = [];
  for (const { content, relativePath } of await readWorkbenchInstructionSources(instructionRoot)) {
    // Inline code shows syntax examples, not live references.
    const live = content.replace(/`[^`\n]*`/gu, "");
    for (const [, ids] of live.matchAll(/<docs tools="([^"]*)">/gu)) {
      for (const id of ids!.split(" ")) if (!servesWorkbenchInstructionTool(id, catalogue)) unknown.push(`${relativePath}: docs ${id}`);
    }
    for (const [, id] of live.matchAll(/<tool id="([^"]*)"\s*\/>/gu)) {
      if (!mcpServed.has(id!)) unknown.push(`${relativePath}: tool ${id}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test("repository instructions render without selector warnings for root and subagent callers on every provider", async () => {
  const sources = await readWorkbenchInstructionSources(instructionRoot);
  const warnings: Array<Pick<WorkbenchInstructionFilterWarning, "field" | "line" | "message">> = [];
  for (const harness of installedProviderKeys) {
    for (const subagent of [false, true]) {
      const visible = selectWorkbenchInstructionTools(catalogue, { harness, subagent }, allCapabilities);
      for (const { content, relativePath } of sources) {
        filterWorkbenchInstructionContent(content, {
          facts: { workspace: new Set(["project", "multi-root"]) },
          field: relativePath,
          harness,
          model: null,
          onWarning: ({ field, line, message }) => warnings.push({ field, line, message }),
          resolveTool: (id) => resolveWorkbenchInstructionToolReference(id, harness, visible),
          servesTool: (id) => servesWorkbenchInstructionTool(id, visible),
          shell: "pwsh",
        });
      }
    }
  }
  assert.deepEqual(warnings, []);
});

test("harness-limited tools gate docs only for the harnesses that can use them", () => {
  const content = "<docs tools=\"rm\">\ndelete claimed files\n</docs>";
  const render = (harness: "claude" | "codex") => {
    const visible = selectWorkbenchInstructionTools(catalogue, { harness, subagent: false }, allCapabilities);
    return filterWorkbenchInstructionContent(content, {
      facts: { workspace: new Set(["project"]) },
      field: "rm.md",
      harness,
      model: null,
      onWarning: () => {},
      resolveTool: (id) => resolveWorkbenchInstructionToolReference(id, harness, visible),
      servesTool: (id) => servesWorkbenchInstructionTool(id, visible),
      shell: "pwsh",
    });
  };
  assert.equal(render("claude"), "delete claimed files");
  assert.equal(render("codex"), "");
});

test("subagent instructions retain coordination without parent-only lifecycle guidance", async () => {
  const source = (await readWorkbenchInstructionSources(instructionRoot))
    .find(({ relativePath }) => relativePath === "wb/mechanics/subagents.md");
  assert.ok(source);
  const visible = selectWorkbenchInstructionTools(catalogue, { harness: "codex", subagent: true }, allCapabilities);
  const output = filterWorkbenchInstructionContent(source.content, {
    facts: { workspace: new Set(["project"]) },
    field: source.relativePath,
    harness: "codex",
    model: null,
    onWarning: () => {},
    resolveTool: (id) => resolveWorkbenchInstructionToolReference(id, "codex", visible),
    servesTool: (id) => servesWorkbenchInstructionTool(id, visible),
    shell: "pwsh",
  });
  assert.match(output, /subagent queues/iu);
  assert.match(output, /subagent_queue/u);
  assert.match(output, /subagent_dequeue/u);
  assert.doesNotMatch(output, /managing subagents|lists unsettled direct children|creates and starts a direct child|parent owns verification/iu);
  for (const tool of ["subagent_create", "subagent_list", "subagent_profiles", "subagent_settle", "subagent_stop", "subagent_wait"]) {
    assert.doesNotMatch(output, new RegExp(tool, "u"));
  }
});
