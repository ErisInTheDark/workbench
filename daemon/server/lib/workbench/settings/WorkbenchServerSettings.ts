/*
 * Exports:
 * - DEFAULT_WORKBENCH_LOCAL_CAPABILITY_SETTINGS: safe defaults for local server capabilities.
 * - normalizeWorkbenchLocalCapabilitySettings: conform capability inputs at the owner boundary.
 * - default WorkbenchServerSettings: own serialised daemon capabilities, auto-compaction, auto resume and discovery settings.
 */
import type WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import { deleteRows, insertRow, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { localCapabilities } from "../database/schema/local-capability-schema";
import { projectDiscoveryRoots } from "../database/schema/project-discovery-settings-schema";
import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { installedProviderKeys, type WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import {
  THREAD_AUTO_COMPACT_DEFAULTS, ThreadAutoCompactPatchSchema, ThreadAutoCompactRules, ThreadAutoCompactRulesSchema,
  type ThreadAutoCompactPatch, type ThreadAutoCompactSettings,
} from "workbench-shared/workbench/settings/thread-auto-compact";
import { threadAutoCompactProviders } from "../database/schema/thread-auto-compact-schema";
import {
  THREAD_AUTO_RESUME_DEFAULTS, ThreadAutoResumePatchSchema, ThreadAutoResumeSettingsSchema, type ThreadAutoResumePatch, type ThreadAutoResumeSettings,
} from "workbench-shared/workbench/settings/thread-auto-resume";
import { threadAutoResumeSettings } from "../database/schema/thread-auto-resume-schema";

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

  /** Providers without a row, or whose stored rules no longer fit their rule set, use their defaults. */
  async readThreadAutoCompact(): Promise<ThreadAutoCompactSettings> {
    const rows = new Map((await this.database.query(selectRows(threadAutoCompactProviders))).map(row => [row.provider, row]));
    return Object.fromEntries(installedProviderKeys.map(provider => {
      const fallback = THREAD_AUTO_COMPACT_DEFAULTS[provider];
      const row = rows.get(provider);
      const stored = row && (row.idle_token_threshold === null) === (fallback.idle === null) && ThreadAutoCompactRulesSchema.safeParse({
        enabled: row.enabled === 1,
        idle: row.idle_token_threshold === null ? null : { tokenThreshold: row.idle_token_threshold, minutes: row.idle_minutes },
        turnEndTokenThreshold: row.turn_end_token_threshold,
      });
      return [provider, stored && stored.success ? stored.data : fallback];
    })) as ThreadAutoCompactSettings;
  }

  async updateThreadAutoCompact(provider: WorkbenchProviderKey, patch: ThreadAutoCompactPatch): Promise<ThreadAutoCompactSettings> {
    const edit = ThreadAutoCompactPatchSchema.parse(patch);
    let settings!: ThreadAutoCompactSettings;
    await this.enqueueWrite(async () => {
      const current = await this.readThreadAutoCompact();
      const rules = ThreadAutoCompactRules.apply(current[provider], edit);
      await this.database.executeTransaction([upsertRow(threadAutoCompactProviders, {
        provider, enabled: rules.enabled ? 1 : 0,
        idle_token_threshold: rules.idle?.tokenThreshold ?? null, idle_minutes: rules.idle?.minutes ?? null,
        turn_end_token_threshold: rules.turnEndTokenThreshold,
      }, {
        conflictColumns: ["provider"],
        updateColumns: ["enabled", "idle_token_threshold", "idle_minutes", "turn_end_token_threshold"],
      })]);
      settings = { ...current, [provider]: rules };
    });
    return settings;
  }

  async readThreadAutoResume(): Promise<ThreadAutoResumeSettings> {
    const [row] = await this.database.query(selectRows(threadAutoResumeSettings, { where: { id: "global" } }));
    const stored = row && ThreadAutoResumeSettingsSchema.safeParse({ enabled: row.enabled === 1, expiredCache: row.expired_cache });
    return stored && stored.success ? stored.data : THREAD_AUTO_RESUME_DEFAULTS;
  }

  async updateThreadAutoResume(patch: ThreadAutoResumePatch): Promise<ThreadAutoResumeSettings> {
    const edit = ThreadAutoResumePatchSchema.parse(patch);
    let settings!: ThreadAutoResumeSettings;
    await this.enqueueWrite(async () => {
      settings = { ...await this.readThreadAutoResume(), ...edit };
      await this.database.executeTransaction([upsertRow(threadAutoResumeSettings, {
        id: "global", enabled: settings.enabled ? 1 : 0, expired_cache: settings.expiredCache,
      }, { conflictColumns: ["id"], updateColumns: ["enabled", "expired_cache"] })]);
    });
    return settings;
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
