/*
 * Exports:
 * - VoiceSettingsSnapshot: acknowledged configuration and catalogue/preparation state.
 * - default VoiceSettingsController: ordered voice settings, stale-response fencing and disposal.
 */
import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { defaultProviderKey, installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { createVoiceConfiguration, readVoiceModelSelection, type VoiceModelSelection } from "workbench-shared/workbench/voice/voice-session-contract";
import type WorkbenchClientStateController from "../state/WorkbenchClientStateController";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";

export interface VoiceSettingsSnapshot {
  selection: VoiceModelSelection | null;
  harness: WorkbenchHarness;
  status: "loading" | "saving" | "disabled" | "preparing" | "ready" | "failed";
  error: string;
  models: readonly WorkbenchModelOption[];
  catalogue: "idle" | "loading" | "ready" | "failed";
  catalogueError: string;
  inputEnabled: boolean;
  canToggle: boolean;
  recordAudio: boolean;
}

export default class VoiceSettingsController {
  private snapshot: VoiceSettingsSnapshot = {
    selection: null, harness: defaultProviderKey, status: "loading", error: "",
    models: [], catalogue: "idle", catalogueError: "",
    inputEnabled: true, canToggle: false, recordAudio: false,
  };
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  // Generations identify async intents, not another copy of configuration truth.
  private configurationRevision = 0;
  private catalogueRevision = 0;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  private readonly unsubscribePreference: () => void;

  constructor(private readonly daemon: {
    voice: Pick<WorkbenchDaemonClient["voice"], "configuration" | "prepare">;
    models: Pick<WorkbenchDaemonClient["models"], "list">;
  }, private readonly preferences?: Pick<WorkbenchClientStateController, "records" | "getSnapshot" | "subscribe" | "put">) {
    this.acceptPreference();
    this.unsubscribePreference = preferences?.subscribe(() => {
      const wasEnabled = this.snapshot.inputEnabled;
      this.acceptPreference();
      if (wasEnabled !== this.snapshot.inputEnabled) {
        if (this.snapshot.inputEnabled) void this.refresh();
        else this.publish({ status: "disabled" });
      }
    }) ?? (() => {});
    this.ready = this.refresh();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  get enabled() { return !this.disposed && this.snapshot.inputEnabled && this.snapshot.selection !== null && this.snapshot.status === "ready"; }

  async refresh() {
    const revision = ++this.configurationRevision;
    this.publish({ status: "loading", error: "" });
    try {
      await this.writes;
      if (!this.current(revision)) return;
      const selection = readVoiceModelSelection(await this.daemon.voice.configuration.read());
      if (!this.current(revision)) return;
      if (selection && selection.harness !== this.snapshot.harness) this.resetCatalogue(selection.harness);
      this.publish({ selection });
      await this.prepareSelection(revision);
    } catch (error) { this.failConfiguration(revision, error); }
  }

  async selectHarness(harness: WorkbenchHarness) {
    if (!installedProviderKeys.some(key => key === harness)) {
      this.failConfiguration(++this.configurationRevision, new Error("The voice harness is not installed."));
      return;
    }
    if (harness === this.snapshot.harness) return;
    this.resetCatalogue(harness);
    await this.select(null);
  }

  async selectModel(model: string) {
    if (this.snapshot.catalogue !== "ready" || !this.snapshot.models.some(option => option.id === model && !option.hidden)) {
      this.failConfiguration(++this.configurationRevision, new Error("The voice model is no longer available. Refresh the model list."));
      return;
    }
    await this.select({ harness: this.snapshot.harness, model });
  }

  disable = () => this.setEnabled(false);
  setRecordAudio(recordAudio: boolean) { this.publish({ recordAudio }); }
  async setEnabled(enabled: boolean) {
    if (!this.preferences || !this.snapshot.canToggle) {
      this.failConfiguration(this.configurationRevision, new Error("Reload the app database to enable browser voice preferences."));
      return;
    }
    try {
      await this.preferences.put({ kind: "globalPreference", preference: { key: "voiceInputEnabled", value: enabled } });
    } catch (error) { this.failConfiguration(this.configurationRevision, error); }
  }

  async loadModels() {
    const revision = ++this.catalogueRevision;
    const harness = this.snapshot.harness;
    this.publish({ catalogue: "loading", catalogueError: "" });
    try {
      const result = await this.daemon.models.list(harness);
      if (this.disposed || revision !== this.catalogueRevision) return;
      this.publish({ models: result.data, catalogue: "ready" });
    } catch (error) {
      console.warn("[voice] model catalogue could not load");
      if (this.disposed || revision !== this.catalogueRevision) return;
      this.publish({ catalogue: "failed", catalogueError: this.message(error) });
    }
  }

  disconnect() {
    ++this.configurationRevision;
    ++this.catalogueRevision;
    this.publish({ status: "loading", error: "", catalogue: "idle", models: [] });
  }

  dispose() {
    this.disposed = true;
    this.unsubscribePreference();
    ++this.configurationRevision;
    ++this.catalogueRevision;
    this.listeners.clear();
  }

  private async select(selection: VoiceModelSelection | null) {
    const revision = ++this.configurationRevision;
    this.publish({ status: "saving", error: "" });
    const write = this.writes.then(async () => {
      if (this.disposed) return;
      await this.daemon.voice.configuration.write(createVoiceConfiguration(selection));
    });
    // The awaiting caller below owns the visible failure; later writes still run.
    this.writes = write.then(() => undefined, () => undefined);
    try {
      await write;
      if (!this.current(revision)) return;
      this.publish({ selection });
      await this.prepareSelection(revision);
    } catch (error) { this.failConfiguration(revision, error); }
  }

  private async prepareSelection(revision: number) {
    if (!this.snapshot.inputEnabled || !this.snapshot.selection) { this.publish({ status: "disabled" }); return; }
    this.publish({ status: "preparing" });
    await this.daemon.voice.prepare();
    if (this.current(revision)) this.publish({ status: this.snapshot.inputEnabled ? "ready" : "disabled" });
  }

  private acceptPreference() {
    const record = this.preferences?.records("globalPreference").find(record => record.preference.key === "voiceInputEnabled");
    this.publish({
      inputEnabled: record?.preference.value !== false,
      canToggle: (this.preferences?.getSnapshot().schemaVersion ?? 0) >= appStateReleases.voiceInputEnabled.version,
    });
  }

  private resetCatalogue(harness: WorkbenchHarness) {
    ++this.catalogueRevision;
    this.publish({ harness, models: [], catalogue: "idle", catalogueError: "" });
  }
  private current(revision: number) { return !this.disposed && revision === this.configurationRevision; }
  private failConfiguration(revision: number, error: unknown) {
    console.warn("[voice] configuration operation failed");
    if (this.current(revision)) this.publish({ status: "failed", error: this.message(error) });
  }
  private message(error: unknown) { return (error instanceof Error ? error.message : "Voice settings are unavailable.").slice(0, 512); }
  private publish(update: Partial<VoiceSettingsSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}
