/*
 * Exports:
 * - default WorkbenchComposerProfileController: own daemon profile definitions and app-owned profile selections. Keywords: composer, profile, controller, daemon, app state.
 * - WorkbenchComposerProfileSnapshot: immutable React-facing profile, selection, and failure snapshot. Keywords: composer, profile, snapshot, error.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileSelection,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  ThreadPayload,
} from "../../types";
import type {
  WorkbenchClientStateIdentity,
  WorkbenchProfilePreferenceValue,
} from "workbench-shared/state/workbench-client-state";
import type { ComposerProfilePersistence } from "./composer-profile-api";
import {
  normalizeComposerProfile,
} from "./composer-profile-state";
import type WorkbenchClientStateController from "./WorkbenchClientStateController";

const EMPTY_CUSTOM_SELECTION: WorkbenchComposerProfileSelection = { kind: "custom" };

export interface WorkbenchComposerProfileSnapshot {
  error: string;
  profiles: readonly WorkbenchComposerProfile[];
  selections: Readonly<Record<string, WorkbenchComposerProfileSelection>>;
}

function createProfileId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `profile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function getSlotKey(slot: WorkbenchComposerProfileSlot) {
  if (slot.kind === "thread") return `thread:${slot.harness}:${slot.threadId}`;
  if (slot.kind === "draft") return `draft:${slot.projectId}:${slot.harness}:${slot.draftId}`;
  return `${slot.kind}:${slot.projectId}`;
}

function cloneSettings(settings: WorkbenchComposerSettings): WorkbenchComposerSettings {
  return {
    agentPath: settings.agentPath,
    agentSource: settings.agentSource,
    harness: settings.harness,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
  };
}

export default class WorkbenchComposerProfileController {
  private readonly clientStateController: WorkbenchClientStateController;
  private error = "";
  private readonly listeners = new Set<() => void>();
  private persistence: ComposerProfilePersistence | null = null;
  private profileMutationQueue: Promise<void> = Promise.resolve();
  private profiles: WorkbenchComposerProfile[] = [];
  private selections: Record<string, WorkbenchComposerProfileSelection> = {};
  private snapshot: WorkbenchComposerProfileSnapshot;
  private readonly unsubscribeClientState: () => void;

  constructor(clientStateController: WorkbenchClientStateController) {
    this.clientStateController = clientStateController;
    this.syncSelections();
    this.snapshot = this.createSnapshot();
    this.unsubscribeClientState = clientStateController.subscribe(() => {
      this.syncSelections();
      this.publish();
    });
  }

  async initializePersistence(persistence: ComposerProfilePersistence) {
    this.persistence = persistence;
    await this.enqueueProfileMutation(async () => {
      const payload = await persistence.read();
      this.profiles = [...payload.profiles];
      this.error = "";
      this.publish();
      return true;
    });
  }

  dispose() {
    this.unsubscribeClientState();
    this.listeners.clear();
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  getSelection(slot: WorkbenchComposerProfileSlot) { return this.selections[getSlotKey(slot)] ?? EMPTY_CUSTOM_SELECTION; }
  getProfile(profileId: string) { return this.profiles.find((profile) => profile.id === profileId) ?? null; }
  getProfileReasoningEffort(profileId: string, harness: WorkbenchHarness) {
    const profile = this.getProfile(profileId);
    return profile?.harness === harness ? profile.reasoningEffort : null;
  }
  getSelectedProfile(slot: WorkbenchComposerProfileSlot) { const selection = this.getSelection(slot); return selection.kind === "profile" ? this.getProfile(selection.profileId) : null; }
  getVisibleProfiles(projectId: string, harness?: WorkbenchHarness | null) {
    return this.profiles.filter((profile) => (!harness || profile.harness === harness) && (profile.scope.kind === "global" || profile.scope.projectId === projectId));
  }

  resolveSettings(slot: WorkbenchComposerProfileSlot, customSettings: WorkbenchComposerSettings | null) {
    const selection = this.getSelection(slot);
    if (selection.kind === "profile") {
      const profile = this.getProfile(selection.profileId);
      if (profile) return cloneSettings(profile);
    }
    return selection.kind === "custom" && selection.pendingSettings
      ? cloneSettings(selection.pendingSettings)
      : customSettings ? cloneSettings(customSettings) : null;
  }

  resolveThread(slot: WorkbenchComposerProfileSlot, thread: ThreadPayload) {
    const customSettings = thread.model ? {
      agentPath: thread.agentPath,
      agentSource: null,
      harness: thread.harness,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      serviceTier: thread.harness === "codex" && thread.serviceTier === "fast" ? "fast" as const : null,
    } : null;
    const settings = this.resolveSettings(slot, customSettings);
    return settings ? {
      ...thread,
      agentPath: settings.agentPath,
      harness: settings.harness,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      serviceTier: settings.serviceTier,
      source: thread.isDraft ? settings.harness : thread.source,
    } : thread;
  }

  async createProfile(input: Omit<WorkbenchComposerProfile, "createdAt" | "id" | "updatedAt">) {
    const now = Date.now();
    const profile = normalizeComposerProfile({ ...input, createdAt: now, id: createProfileId(), updatedAt: now });
    if (!profile) return this.fail("Profile model and scope are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") return this.fail("Profiles using a project agent cannot be global.");
    return await this.enqueueProfileMutation(async () => {
      const payload = await this.requirePersistence().mutate({ kind: "upsert", profile });
      this.profiles = [...payload.profiles];
      this.error = "";
      this.publish();
      return this.getProfile(profile.id);
    });
  }

  async updateProfile(profileId: string, update: Partial<Omit<WorkbenchComposerProfile, "createdAt" | "harness" | "id">>) {
    return await this.enqueueProfileMutation(async () => {
      const existing = this.getProfile(profileId);
      if (!existing) return null;
      const profile = normalizeComposerProfile({ ...existing, ...update, createdAt: existing.createdAt, harness: existing.harness, id: existing.id, updatedAt: Date.now() });
      if (!profile) throw new Error("Profile name and model are required.");
      if (profile.scope.kind === "global" && profile.agentSource === "project") throw new Error("Profiles using a project agent cannot be global.");
      const payload = await this.requirePersistence().mutate({ kind: "upsert", profile });
      this.profiles = [...payload.profiles];
      this.error = "";
      this.publish();
      return this.getProfile(profile.id);
    });
  }

  async deleteProfile(profileId: string) {
    return await this.enqueueProfileMutation(async () => {
      const profile = this.getProfile(profileId);
      if (!profile) return null;
      const affectedSlots = this.readSelectionSlots().filter(({ selection }) => (
        selection.kind === "profile" && selection.profileId === profileId
      ));
      const payload = await this.requirePersistence().mutate({ kind: "delete", profileId });
      this.profiles = [...payload.profiles];
      this.error = "";
      this.publish();
      await Promise.all(affectedSlots.map(async ({ slot }) => {
        await this.persistSelection(slot, { kind: "custom", pendingSettings: cloneSettings(profile) });
      }));
      return profile;
    });
  }

  selectCustom(slot: WorkbenchComposerProfileSlot, pendingSettings?: WorkbenchComposerSettings) {
    void this.persistSelection(slot, pendingSettings ? { kind: "custom", pendingSettings: cloneSettings(pendingSettings) } : EMPTY_CUSTOM_SELECTION);
  }
  selectProfile(slot: WorkbenchComposerProfileSlot, profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile || ((slot.kind === "thread" || slot.kind === "draft") && profile.harness !== slot.harness)) return false;
    void this.persistSelection(slot, { kind: "profile", profileId });
    return true;
  }
  acknowledgePendingSettings(slot: WorkbenchComposerProfileSlot) {
    const selection = this.getSelection(slot);
    if (selection.kind === "custom" && selection.pendingSettings) this.selectCustom(slot);
  }
  materializeSelection(sourceSlot: WorkbenchComposerProfileSlot, threadId: string, harness: WorkbenchHarness) {
    const selection = this.getSelection(sourceSlot);
    if (selection.kind === "profile" && this.getProfile(selection.profileId)?.harness === harness) {
      void this.persistSelection({ harness, kind: "thread", threadId }, selection);
    }
  }

  materializeDraftSelection(sourceSlot: WorkbenchComposerProfileSlot, draftId: string, harness: WorkbenchHarness, projectId: string) {
    const selection = this.getSelection(sourceSlot);
    if (selection.kind === "profile" && this.getProfile(selection.profileId)?.harness === harness) {
      void this.persistSelection({ draftId, harness, kind: "draft", projectId }, selection);
    } else if (selection.kind === "custom" && selection.pendingSettings?.harness === harness) {
      void this.persistSelection({ draftId, harness, kind: "draft", projectId }, selection);
    }
  }

  private async persistSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileSelection) {
    try {
      const identity = this.selectionIdentity(slot);
      if (selection.kind === "custom" && !selection.pendingSettings) {
        await this.clientStateController.delete(identity);
      } else {
        const value: WorkbenchProfilePreferenceValue = selection.kind === "profile"
          ? { kind: "daemon-profile", profileId: selection.profileId }
          : { kind: "custom", settings: cloneSettings(selection.pendingSettings!) };
        if (slot.kind === "thread") {
          await this.clientStateController.put({
            daemonRegistrationId: this.clientStateController.daemonRegistrationId,
            harness: slot.harness,
            kind: "threadProfilePreference",
            threadId: slot.threadId,
            value,
          });
        } else if (slot.kind === "draft") {
          await this.clientStateController.put({
            daemonRegistrationId: this.clientStateController.daemonRegistrationId,
            draftId: slot.draftId,
            harness: slot.harness,
            kind: "draftProfilePreference",
            projectId: slot.projectId,
            value,
          });
        } else {
          await this.clientStateController.put({
            daemonRegistrationId: this.clientStateController.daemonRegistrationId,
            kind: "newThreadProfilePreference",
            projectId: slot.projectId,
            value,
          });
        }
      }
      this.error = "";
      this.publish();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Unable to persist the composer profile selection.");
    }
  }

  private selectionIdentity(slot: WorkbenchComposerProfileSlot): Extract<
    WorkbenchClientStateIdentity,
    { kind: "newThreadProfilePreference" | "draftProfilePreference" | "threadProfilePreference" }
  > {
    const daemonRegistrationId = this.clientStateController.daemonRegistrationId;
    if (slot.kind === "thread") {
      return { daemonRegistrationId, harness: slot.harness, kind: "threadProfilePreference" as const, threadId: slot.threadId };
    }
    if (slot.kind === "draft") {
      return { daemonRegistrationId, draftId: slot.draftId, harness: slot.harness, kind: "draftProfilePreference" as const, projectId: slot.projectId };
    }
    return { daemonRegistrationId, kind: "newThreadProfilePreference" as const, projectId: slot.projectId };
  }

  private readSelectionSlots(): Array<{
    selection: WorkbenchComposerProfileSelection;
    slot: WorkbenchComposerProfileSlot;
  }> {
    const daemonRegistrationId = this.clientStateController.daemonRegistrationId;
    const entries: Array<{
      selection: WorkbenchComposerProfileSelection;
      slot: WorkbenchComposerProfileSlot;
    }> = [];
    for (const record of this.clientStateController.getSnapshot().records) {
      if (!("daemonRegistrationId" in record) || record.daemonRegistrationId !== daemonRegistrationId) continue;
      if (record.kind === "newThreadProfilePreference") {
        entries.push({ selection: this.selectionFromValue(record.value), slot: { kind: "new-thread", projectId: record.projectId } });
        continue;
      }
      if (record.kind === "draftProfilePreference") {
        entries.push({ selection: this.selectionFromValue(record.value), slot: { draftId: record.draftId, harness: record.harness, kind: "draft", projectId: record.projectId } });
        continue;
      }
      if (record.kind === "threadProfilePreference") {
        entries.push({ selection: this.selectionFromValue(record.value), slot: { harness: record.harness, kind: "thread", threadId: record.threadId } });
      }
    }
    return entries;
  }

  private selectionFromValue(value: WorkbenchProfilePreferenceValue): WorkbenchComposerProfileSelection {
    return value.kind === "daemon-profile"
      ? { kind: "profile", profileId: value.profileId }
      : { kind: "custom", pendingSettings: cloneSettings(value.settings) };
  }

  private syncSelections() {
    this.selections = Object.fromEntries(this.readSelectionSlots().map(({ selection, slot }) => [
      getSlotKey(slot),
      selection,
    ]));
  }

  private requirePersistence() {
    if (!this.persistence) throw new Error("Composer profiles are not connected to the daemon.");
    return this.persistence;
  }

  private async enqueueProfileMutation<Result>(operation: () => Promise<Result>) {
    const result = this.profileMutationQueue.then(operation);
    this.profileMutationQueue = result.then(() => undefined, () => undefined);
    try {
      return await result;
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Unable to persist composer profiles.");
    }
  }

  private fail(message: string): null {
    this.error = message;
    this.publish();
    return null;
  }

  private publish() {
    this.snapshot = this.createSnapshot();
    this.listeners.forEach((listener) => listener());
  }

  private createSnapshot(): WorkbenchComposerProfileSnapshot {
    return { error: this.error, profiles: this.profiles, selections: this.selections };
  }
}
