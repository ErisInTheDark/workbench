/*
 * Exports:
 * - buildOpenCodeWorkbenchSystemPrompt: compose sentinel-wrapped Workbench instructions for OpenCode prompt calls. Keywords: opencode, system, instructions.
 * - ensureOpenCodeWorkbenchConfigDirectory: create the managed-server config directory by overlaying the Workbench OpenCode plugin onto the user's OpenCode config. Keywords: opencode, plugin, config, overlay.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dirent } from "node:fs";

import type { WorkbenchPromptInstructions } from "../lib/workbench/instructions/WorkbenchPromptFiles";

const WORKBENCH_OPENCODE_SYSTEM_BEGIN = "<<<WORKBENCH_OPENCODE_SYSTEM_REPLACEMENT_BEGIN_V1>>>";
const WORKBENCH_OPENCODE_SYSTEM_END = "<<<WORKBENCH_OPENCODE_SYSTEM_REPLACEMENT_END_V1>>>";
const WORKBENCH_OPENCODE_CONFIG_DIR_NAME = "workbench-opencode";
const WORKBENCH_OPENCODE_PLUGIN_FILE = "plugins/workbench-system-replacement.js";
const WORKBENCH_OPENCODE_PLUGIN_CONFIG_ENTRY = `./${WORKBENCH_OPENCODE_PLUGIN_FILE}`;

type EnsureOpenCodeWorkbenchConfigDirectoryOptions = {
  baseConfigDirectory?: string | null;
};

type CopyConfigDirectoryContentsResult = {
  copied: boolean;
  metadata: OpenCodeConfigDirectoryMetadata | null;
  unavailableReason: string | null;
};

type OpenCodeConfigDirectoryMetadata = {
  hasBunLock: boolean;
  hasNodeModules: boolean;
  hasPackageJson: boolean;
  hasPackageLock: boolean;
  topLevelEntryCount: number;
};

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

function defaultOpenCodeConfigDirectory() {
  const configuredXdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(configuredXdgConfigHome || path.join(os.homedir(), ".config"), "opencode");
}

function normalizeOptionalPath(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function comparablePath(value: string) {
  const resolvedPath = path.resolve(value);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isSameDirectory(left: string, right: string) {
  return comparablePath(left) === comparablePath(right);
}

function nodeErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function summarizeConfigDirectoryEntries(entries: Dirent[]): OpenCodeConfigDirectoryMetadata {
  const names = new Set(entries.map((entry) => entry.name));
  return {
    hasBunLock: names.has("bun.lock"),
    hasNodeModules: names.has("node_modules"),
    hasPackageJson: names.has("package.json"),
    hasPackageLock: names.has("package-lock.json"),
    topLevelEntryCount: entries.length,
  };
}

async function copyConfigDirectoryContents(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<CopyConfigDirectoryContentsResult> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
      return {
        copied: false,
        metadata: null,
        unavailableReason: code,
      };
    }
    throw error;
  }

  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    await fs.cp(sourcePath, destinationPath, {
      force: true,
      recursive: true,
    });
  }
  return {
    copied: true,
    metadata: summarizeConfigDirectoryEntries(entries),
    unavailableReason: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePluginEntries(value: unknown) {
  if (!Array.isArray(value)) {
    return [WORKBENCH_OPENCODE_PLUGIN_CONFIG_ENTRY];
  }

  const hasWorkbenchPlugin = value.some((entry) => (
    entry === WORKBENCH_OPENCODE_PLUGIN_CONFIG_ENTRY
    || (Array.isArray(entry) && entry[0] === WORKBENCH_OPENCODE_PLUGIN_CONFIG_ENTRY)
  ));
  return hasWorkbenchPlugin
    ? value
    : [...value, WORKBENCH_OPENCODE_PLUGIN_CONFIG_ENTRY];
}

async function tryRegisterWorkbenchPlugin(configPath: string) {
  let rawConfig: string;
  try {
    rawConfig = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }

  const parsedConfig = JSON.parse(rawConfig) as unknown;
  const config = isRecord(parsedConfig) ? parsedConfig : {};
  config.plugin = normalizePluginEntries(config.plugin);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

async function registerWorkbenchPlugin(configDirectory: string) {
  const configPaths = [
    path.join(configDirectory, "opencode.json"),
    path.join(configDirectory, "opencode.jsonc"),
  ];
  const results = await Promise.allSettled(configPaths.map(tryRegisterWorkbenchPlugin));
  if (results.some((result) => result.status === "fulfilled" && result.value)) {
    return;
  }

  await fs.writeFile(
    configPaths[0],
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [WORKBENCH_OPENCODE_PLUGIN_CONFIG_ENTRY],
    }, null, 2)}\n`,
    "utf8",
  );
}

export async function ensureOpenCodeWorkbenchConfigDirectory(
  options: EnsureOpenCodeWorkbenchConfigDirectoryOptions = {},
) {
  const configDirectory = path.join(os.tmpdir(), WORKBENCH_OPENCODE_CONFIG_DIR_NAME);
  const baseConfigDirectory = normalizeOptionalPath(options.baseConfigDirectory) ?? defaultOpenCodeConfigDirectory();
  await fs.rm(configDirectory, { force: true, recursive: true });
  await fs.mkdir(configDirectory, { recursive: true });
  const baseConfigCopy = isSameDirectory(baseConfigDirectory, configDirectory)
    ? { copied: false, metadata: null, unavailableReason: "self" }
    : await copyConfigDirectoryContents(baseConfigDirectory, configDirectory);
  const pluginPath = path.join(configDirectory, WORKBENCH_OPENCODE_PLUGIN_FILE);
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.writeFile(pluginPath, buildOpenCodeSystemReplacementPluginSource(), "utf8");
  await registerWorkbenchPlugin(configDirectory);
  return {
    baseConfigDirectory,
    baseConfigMetadata: baseConfigCopy.metadata,
    configDirectory,
    copiedBaseConfig: baseConfigCopy.copied,
    unavailableBaseConfigReason: baseConfigCopy.unavailableReason,
  };
}
