/*
 * Exports:
 * - default VoiceSettingsStore: ordered model selection with legacy storage isolated at this boundary.
 */
import { deleteRows, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { VoiceConfigurationSchema, createVoiceConfiguration, readVoiceModelSelection, type VoiceConfiguration, type VoiceModelSelection } from "workbench-shared/workbench/voice/voice-session-contract";
import { workbenchHarnesses } from "workbench-shared/workbench/database/schema/core-schema";
import type { WorkbenchComposerProfileDatabase } from "../WorkbenchComposerProfileStore";
import { voiceProfileLink, voiceSettings } from "../lib/workbench/database/schema/voice-settings-schema";

export default class VoiceSettingsStore {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly database: WorkbenchComposerProfileDatabase) {}
  read(): Promise<VoiceConfiguration> { return this.enqueue(() => this.readCurrent()); }
  write(value: VoiceConfiguration) { return this.enqueue(() => this.writeCurrent(value)); }
  async dispose() { this.closed = true; await this.pending; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Voice settings are reloading."));
    const result = this.pending.then(operation);
    // A caller receives the failure; subsequent independent settings operations may proceed.
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  private async readCurrent(): Promise<VoiceConfiguration> {
    const rows = await this.database.query(selectRows(voiceSettings));
    const row = rows[0];
    if (!row) return { selection: null };
    return createVoiceConfiguration({ harness: row.harness, model: row.model });
  }
  private async writeCurrent(value: VoiceConfiguration) {
    const settings = readVoiceModelSelection(VoiceConfigurationSchema.parse(value));
    if (!settings) {
      await this.database.executeTransaction([deleteRows(voiceProfileLink, { id: "voice" }), deleteRows(voiceSettings, { id: "voice" })]);
      return;
    }
    await this.database.executeTransaction([
      upsertRow(workbenchHarnesses, { id: settings.harness }, { conflictColumns: ["id"], updateColumns: ["id"] }),
      upsertRow(voiceSettings, {
        id: "voice", harness: settings.harness, model: settings.model, agent_path: null,
        agent_source: null, reasoning_effort: "none",
        service_tier: null, context_window_tokens: null,
      }, { conflictColumns: ["id"], updateColumns: ["harness", "model", "agent_path", "agent_source", "reasoning_effort", "service_tier", "context_window_tokens"] }),
      deleteRows(voiceProfileLink, { id: "voice" }),
    ]);
  }
  async resolve(): Promise<VoiceModelSelection> {
    const settings = readVoiceModelSelection(await this.read());
    if (!settings) throw new Error("Select a voice harness and model in global settings.");
    return settings;
  }
}
