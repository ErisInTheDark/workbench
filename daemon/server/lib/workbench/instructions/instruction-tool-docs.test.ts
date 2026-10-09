/*
 * No production exports. Protect docs collection across sources for one caller, and repository instructions against tool ids
 * no catalogue serves and selectors that warn at render time.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { WORKBENCH_SHELL_MCP_TOOL_NAME } from "workbench-shared/workbench/commands/workbench-shell-command";
import { isWorkbenchToolVisibleTo } from "workbench-shared/workbench/commands/workbench-tool-audience";
import { getWorkbenchAgentCommandToolName } from "../commands/workbench-agent-command-definition";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry";
import { filterWorkbenchInstructionContent, type WorkbenchInstructionFilterWarning } from "./instruction-context-filter";
import { readWorkbenchInstructionSources } from "./instruction-source";
import { collectWorkbenchInstructionToolDocs } from "./instruction-tool-docs";
import { resolveWorkbenchInstructionToolReference } from "./instruction-tool-reference";

const instructionRoot = fileURLToPath(new URL("../../../../../instructions", import.meta.url));
const catalogue = [
  { id: WORKBENCH_SHELL_MCP_TOOL_NAME, codeModeEligible: true },
  ...listWorkbenchAgentCommands([], "agent", { virtualRepos: true })
    .filter(({ hideFromMcp }) => !hideFromMcp)
    .map((definition) => ({ id: getWorkbenchAgentCommandToolName(definition), codeModeEligible: definition.mcpCodeModeEligible === true })),
];
const registered = new Set(catalogue.map(({ id }) => id));

test("docs text groups by tools across sources and only counts what this caller would render", () => {
  const docs = collectWorkbenchInstructionToolDocs([
    { relativePath: "a.md", content: "<docs tools=\"message\">\nsend\n<harness:opencode>\nopencode only\n</harness:opencode>\n</docs>" },
    { relativePath: "b.md", content: "<docs tools=\"message\">\nagain\n</docs>\n<docs tools=\"hidden_tool\">\nunseen\n</docs>" },
  ], {
    facts: { settings: new Set(), workspace: new Set(["project"]) },
    harness: "codex",
    model: null,
    resolveTool: (id) => id === "message" ? "tools.mcp__wb__message" : null,
    shell: "pwsh",
  });
  assert.deepEqual(docs, [{ text: "send\nagain", tools: ["message"] }]);
});

test("every docs region and tool reference in repository instructions names a served wb tool", async () => {
  const unknown: string[] = [];
  for (const { content, relativePath } of await readWorkbenchInstructionSources(instructionRoot)) {
    // Inline code shows syntax examples, not live references.
    const live = content.replace(/`[^`\n]*`/gu, "");
    for (const [, ids] of live.matchAll(/<docs tools="([^"]*)">/gu)) {
      for (const id of ids!.split(" ")) if (!registered.has(id)) unknown.push(`${relativePath}: docs ${id}`);
    }
    for (const [, id] of live.matchAll(/<tool id="([^"]*)"\s*\/>/gu)) {
      if (!registered.has(id!)) unknown.push(`${relativePath}: tool ${id}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test("repository instructions render without selector warnings for root and subagent callers on every provider", async () => {
  const sources = await readWorkbenchInstructionSources(instructionRoot);
  const warnings: Array<Pick<WorkbenchInstructionFilterWarning, "field" | "line" | "message">> = [];
  for (const harness of installedProviderKeys) {
    for (const subagent of [false, true]) {
      const visible = catalogue.filter(({ id }) => isWorkbenchToolVisibleTo(id, subagent));
      for (const { content, relativePath } of sources) {
        filterWorkbenchInstructionContent(content, {
          facts: { settings: new Set(["browse-raw"]), workspace: new Set(["project", "multi-root"]) },
          field: relativePath,
          harness,
          model: null,
          onWarning: ({ field, line, message }) => warnings.push({ field, line, message }),
          resolveTool: (id) => resolveWorkbenchInstructionToolReference(id, harness, visible),
          shell: "pwsh",
        });
      }
    }
  }
  assert.deepEqual(warnings, []);
});
