/*
 * Exports:
 * - DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS: safe defaults for local server capabilities.
 * - normalizeWorkbenchLocalCapabilitySettings: conform capability inputs at the owner boundary.
 * - default WorkbenchServerSettings: own serialised SQLite capability and discovery-root updates.
 */
import type WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import { deleteRows, insertRow, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { localCapabilities } from "../database/schema/local-capability-schema";
import { projectDiscoveryRoots } from "../database/schema/project-discovery-settings-schema";
import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";

export const DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS: WorkbenchLocalCapabilitySettings = {
  browseRawCommandsEnabled: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWorkbenchLocalCapabilitySettings(value: unknown): WorkbenchLocalCapabilitySettings {
  const candidate = isRecord(value) ? value : {};
  return {
    browseRawCommandsEnabled: candidate.browseRawCommandsEnabled === true,
  };
}

export default class WorkbenchServerSettings {
  private writeQueue = Promise.resolve();

  constructor(private readonly database: Pick<WorkbenchDatabaseController, "query" | "executeTransaction">) {}

  async readLocalCapabilities() {
    const [row] = await this.database.query(selectRows(localCapabilities, { where: { id: "global" } }));
    return { browseRawCommandsEnabled: row?.browse_raw_commands_enabled === 1 };
  }

  async readProjectDiscoveryRoots(): Promise<string[]> {
    const rows = await this.database.query(selectRows(projectDiscoveryRoots, { orderBy: [{ column: "position" }] }));
    return rows.map(row => row.path);
  }

  async replaceProjectDiscoveryRoots(roots: readonly string[]): Promise<void> {
    await this.enqueueWrite(async () => {
      const previous = await this.database.query(selectRows(projectDiscoveryRoots));
      await this.database.executeTransaction([
        ...previous.map(row => deleteRows(projectDiscoveryRoots, { position: row.position })),
        ...roots.map((root, position) => insertRow(projectDiscoveryRoots, { path: root, position })),
      ]);
    });
  }

  async writeLocalCapabilities(settings: WorkbenchLocalCapabilitySettings) {
    const normalizedSettings = normalizeWorkbenchLocalCapabilitySettings(settings);
    await this.enqueueWrite(async () => {
      await this.persist(normalizedSettings);
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
      await this.persist(nextSettings);
    });
    return nextSettings;
  }

  private async enqueueWrite(task: () => Promise<void>) {
    const nextWrite = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = nextWrite.then(() => undefined, () => undefined);
    await nextWrite;
  }

  private async persist(settings: WorkbenchLocalCapabilitySettings) {
    await this.database.executeTransaction([upsertRow(localCapabilities, {
      id: "global", browse_raw_commands_enabled: settings.browseRawCommandsEnabled ? 1 : 0,
    }, { conflictColumns: ["id"], updateColumns: ["browse_raw_commands_enabled"] })]);
  }
}
