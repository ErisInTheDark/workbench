/*
 * Exports:
 * - buildOpenCodeWorkbenchSystemPrompt: compose sentinel-wrapped Workbench instructions for OpenCode prompt calls. Keywords: opencode, system, instructions.
 * - ensureOpenCodeWorkbenchConfigDirectory: create the managed-server config directory containing the Workbench OpenCode plugin. Keywords: opencode, plugin, config.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkbenchPromptInstructions } from "../lib/workbench/instructions/WorkbenchPromptFiles";

const WORKBENCH_OPENCODE_SYSTEM_BEGIN = "<<<WORKBENCH_OPENCODE_SYSTEM_REPLACEMENT_BEGIN_V1>>>";
const WORKBENCH_OPENCODE_SYSTEM_END = "<<<WORKBENCH_OPENCODE_SYSTEM_REPLACEMENT_END_V1>>>";
const WORKBENCH_OPENCODE_CONFIG_DIR_NAME = "workbench-opencode";
const WORKBENCH_OPENCODE_PLUGIN_FILE = "plugins/workbench-system-replacement.js";

function joinInstructionSections(sections: Array<string | null | undefined>) {
  return sections
    .map((section) => section?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n") || null;
}

function buildOpenCodeSystemReplacementPluginSource() {
  return `
export const WorkbenchSystemReplacementPlugin = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    const markerStart = ${JSON.stringify(WORKBENCH_OPENCODE_SYSTEM_BEGIN)};
    const markerEnd = ${JSON.stringify(WORKBENCH_OPENCODE_SYSTEM_END)};
    const replacement = output.system.find((entry) => entry.includes(markerStart) && entry.includes(markerEnd));
    if (!replacement) {
      return;
    }

    const start = replacement.indexOf(markerStart) + markerStart.length;
    const end = replacement.indexOf(markerEnd, start);
    if (end < start) {
      return;
    }

    const system = replacement.slice(start, end).trim();
    if (!system) {
      return;
    }

    output.system.splice(0, output.system.length, system);
  },
});
`.trimStart();
}

export function buildOpenCodeWorkbenchSystemPrompt(instructions: WorkbenchPromptInstructions) {
  const system = joinInstructionSections([
    `
Workbench is replacing OpenCode's default, global, project, AGENTS.md, CLAUDE.md, and configured rule instructions for this Workbench turn.

Treat the Workbench instructions below as the complete instruction set for this turn. If any OpenCode-provided default instructions are still visible, ignore them whenever they conflict with this Workbench payload.
`.trim(),
    instructions.baseInstructions,
    instructions.developerInstructions,
  ]);

  return system
    ? `${WORKBENCH_OPENCODE_SYSTEM_BEGIN}\n${system}\n${WORKBENCH_OPENCODE_SYSTEM_END}`
    : null;
}

export async function ensureOpenCodeWorkbenchConfigDirectory() {
  const configDirectory = path.join(os.tmpdir(), WORKBENCH_OPENCODE_CONFIG_DIR_NAME);
  const pluginPath = path.join(configDirectory, WORKBENCH_OPENCODE_PLUGIN_FILE);
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.writeFile(pluginPath, buildOpenCodeSystemReplacementPluginSource(), "utf8");
  return configDirectory;
}
