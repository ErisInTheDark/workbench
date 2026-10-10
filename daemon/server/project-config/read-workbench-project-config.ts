/*
 * Exports:
 * - readWorkbenchProjectConfig: read a project's `.wb.json`, repairing what does not fit so one bad entry never
 *   disables the rest; a missing file is an empty config.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKBENCH_PROJECT_CONFIG_FILE, WORKBENCH_PROJECT_CONFIG_REPAIR_TEMPLATE, WorkbenchProjectConfigSchema, type WorkbenchProjectConfig,
} from "workbench-shared/workbench/project-config/workbench-project-config";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";

/**
 * Read on each use, so edits apply without a reload. `ignored` names every path dropped or defaulted, so a
 * feature whose setting vanished can say why instead of claiming it was never configured.
 */
export async function readWorkbenchProjectConfig(rootPath: string): Promise<{ config: WorkbenchProjectConfig; ignored: string[] }> {
  let text: string;
  try {
    text = await readFile(path.join(rootPath, WORKBENCH_PROJECT_CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, ignored: [] };
    throw error;
  }
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { return { config: {}, ignored: ["(the whole file is not valid JSON)"] }; }
  const { data, repairedPaths } = conformToZodSchema(WorkbenchProjectConfigSchema, json, WORKBENCH_PROJECT_CONFIG_REPAIR_TEMPLATE);
  return { config: data, ignored: repairedPaths.map((parts) => parts.map(String).join(".") || "(top level)") };
}
