/*
 * Exports:
 * - DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS: safe defaults for local server capabilities. Keywords: settings, capabilities, browse, default.
 * - WORKBENCH_LOCAL_CAPABILITY_SETTINGS_PATH: repository-local persisted local capability settings file. Keywords: settings, file, .workbench.
 * - normalizeWorkbenchLocalCapabilitySettings: normalize persisted local capability settings. Keywords: settings, normalize, capabilities.
 * - default WorkbenchServerSettings: server-readable Workbench settings controller. Keywords: settings, server, local capabilities, browse.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { projectRoot } from "../../project";
import type { WorkbenchLocalCapabilitySettings } from "../../types";

export const DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS: WorkbenchLocalCapabilitySettings = {
  browseRawCommandsEnabled: false,
};

export const WORKBENCH_LOCAL_CAPABILITY_SETTINGS_PATH = path.join(
  projectRoot,
  ".workbench",
  "settings",
  "local-capabilities.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWorkbenchLocalCapabilitySettings(value: unknown): WorkbenchLocalCapabilitySettings {
  const candidate = isRecord(value) ? value : {};
  return {
    browseRawCommandsEnabled: candidate.browseRawCommandsEnabled === true,
  };
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export default class WorkbenchServerSettings {
  private writeQueue = Promise.resolve();

  constructor(private readonly localCapabilitySettingsPath = WORKBENCH_LOCAL_CAPABILITY_SETTINGS_PATH) {}

  async readLocalCapabilities() {
    try {
      const rawValue = JSON.parse(await fs.readFile(this.localCapabilitySettingsPath, "utf8"));
      return normalizeWorkbenchLocalCapabilitySettings(rawValue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }

      return DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS;
    }
  }

  async writeLocalCapabilities(settings: WorkbenchLocalCapabilitySettings) {
    const normalizedSettings = normalizeWorkbenchLocalCapabilitySettings(settings);
    await this.enqueueWrite(async () => {
      await writeJsonFile(this.localCapabilitySettingsPath, normalizedSettings);
    });
    return normalizedSettings;
  }

  async updateLocalCapabilities(
    updater: (current: WorkbenchLocalCapabilitySettings) => WorkbenchLocalCapabilitySettings,
  ) {
    let nextSettings = DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS;
    await this.enqueueWrite(async () => {
      const currentSettings = await this.readLocalCapabilities();
      nextSettings = normalizeWorkbenchLocalCapabilitySettings(updater(currentSettings));
      await writeJsonFile(this.localCapabilitySettingsPath, nextSettings);
    });
    return nextSettings;
  }

  private async enqueueWrite(task: () => Promise<void>) {
    const nextWrite = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = nextWrite.then(() => undefined, () => undefined);
    await nextWrite;
  }
}
