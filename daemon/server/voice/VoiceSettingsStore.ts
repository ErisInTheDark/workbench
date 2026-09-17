/*
 * Exports:
 * - default VoiceSettingsStore: typed daemon voice selection and current profile resolution.
 */
import { deleteRows, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import type { WorkbenchComposerProfileTargetSelection, WorkbenchComposerSettings } from "workbench-shared/types";
import { VoiceConfigurationSchema, type VoiceConfiguration } from "workbench-shared/workbench/voice/voice-session-contract";
import { workbenchHarnesses } from "workbench-shared/workbench/database/schema/core-schema";
import type WorkbenchComposerProfileStore from "../WorkbenchComposerProfileStore";
import type { WorkbenchComposerProfileDatabase } from "../WorkbenchComposerProfileStore";
import { voiceProfileLink, voiceSettings } from "../lib/workbench/database/schema/voice-settings-schema";

export default class VoiceSettingsStore {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly database: WorkbenchComposerProfileDatabase, private readonly profiles: Pick<WorkbenchComposerProfileStore, "read">) {}
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
    const [rows, links] = await Promise.all([
      this.database.query(selectRows(voiceSettings)),
      this.database.query(selectRows(voiceProfileLink)),
    ]);
    const row = rows[0];
    if (!row) return { selection: null };
    const settings: WorkbenchComposerSettings = {
      harness: row.harness, model: row.model, agentPath: row.agent_path, agentSource: row.agent_source,
      reasoningEffort: row.reasoning_effort, serviceTier: row.service_tier, contextWindowTokens: row.context_window_tokens,
    };
    const link = links[0];
    const profile = link ? (await this.profiles.read()).profiles.find(profile => profile.id === link.profile_id && profile.scope.kind === "global") : null;
    return { selection: profile ? { kind: "profile", profileId: profile.id, settings } : { kind: "custom", settings } };
  }
  private async writeCurrent(value: VoiceConfiguration) {
    const { selection } = VoiceConfigurationSchema.parse(value);
    if (!selection) {
      await this.database.executeTransaction([deleteRows(voiceProfileLink, { id: "voice" }), deleteRows(voiceSettings, { id: "voice" })]);
      return;
    }
    const settings = await this.resolveSelection(selection);
    if (settings.agentSource === "project") throw new Error("Global voice requires a library agent.");
    await this.database.executeTransaction([
      upsertRow(workbenchHarnesses, { id: settings.harness }, { conflictColumns: ["id"], updateColumns: ["id"] }),
      upsertRow(voiceSettings, {
        id: "voice", harness: settings.harness, model: settings.model, agent_path: settings.agentPath,
        agent_source: settings.agentSource, reasoning_effort: settings.reasoningEffort,
        service_tier: settings.serviceTier, context_window_tokens: settings.contextWindowTokens ?? null,
      }, { conflictColumns: ["id"], updateColumns: ["harness", "model", "agent_path", "agent_source", "reasoning_effort", "service_tier", "context_window_tokens"] }),
      ...(selection.kind === "profile" ? [upsertRow(voiceProfileLink, { id: "voice", profile_id: selection.profileId }, { conflictColumns: ["id"], updateColumns: ["profile_id"] })]
        : [deleteRows(voiceProfileLink, { id: "voice" })]),
    ]);
  }
  async resolve(): Promise<WorkbenchComposerSettings> {
    const { selection } = await this.read();
    if (!selection) throw new Error("Select a voice profile in global settings.");
    const settings = await this.resolveSelection(selection);
    if (settings.reasoningEffort !== "none") throw new Error("Select reasoning effort none for realtime voice.");
    return settings;
  }
  private async resolveSelection(selection: WorkbenchComposerProfileTargetSelection): Promise<WorkbenchComposerSettings> {
    if (selection.kind === "custom") return { ...selection.settings };
    const profile = (await this.profiles.read()).profiles.find(profile => profile.id === selection.profileId);
    if (!profile) return { ...selection.settings };
    if (profile.scope.kind !== "global" || profile.agentSource === "project") throw new Error("Select a global voice profile.");
    return { harness: profile.harness, model: profile.model, agentPath: profile.agentPath, agentSource: profile.agentSource,
      reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier, contextWindowTokens: profile.contextWindowTokens };
  }
}
