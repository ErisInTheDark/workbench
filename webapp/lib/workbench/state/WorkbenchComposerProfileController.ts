/*
 * Exports:
 * - default WorkbenchComposerProfileController: own daemon profile definitions and guarded daemon-target projections. Keywords: composer, profile, controller, daemon, projection.
 * - WorkbenchComposerProfileSnapshot: immutable React-facing profile, selection, and failure snapshot. Keywords: composer, profile, snapshot, error.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileSelection,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  ThreadPayload,
} from "../../types";
import type { ComposerProfilePersistence, ComposerProfileTargetPersistence } from "./composer-profile-api";
import {
  normalizeComposerProfile,
} from "./composer-profile-state";

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
  if (slot.kind === "thread") return `thread:${slot.projectId}:${slot.harness}:${slot.threadId}`;
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
  private error = "";
  private readonly listeners = new Set<() => void>();
  private persistence: ComposerProfilePersistence | null = null;
  private profileMutationQueue: Promise<void> = Promise.resolve();
  private profiles: WorkbenchComposerProfile[] = [];
  private profilesLoaded = false;
  private readonly selectionGenerations = new Map<string, number>();
  private readonly selectionMutationQueues = new Map<string, Promise<void>>();
  private readonly slots = new Map<string, WorkbenchComposerProfileSlot>();
  private readonly stableSelections = new Map<string, WorkbenchComposerProfileTargetSelection>();
  private selections: Record<string, WorkbenchComposerProfileSelection> = {};
  private snapshot: WorkbenchComposerProfileSnapshot;
  private targetPersistence: ComposerProfileTargetPersistence | null = null;

  constructor() {
    this.snapshot = this.createSnapshot();
  }

  async initializePersistence(persistence: ComposerProfilePersistence) {
    this.persistence = persistence;
    await this.enqueueProfileMutation(async () => {
      const payload = await persistence.read();
      this.profiles = [...payload.profiles];
      this.profilesLoaded = true;
      this.error = "";
      this.publish();
      return true;
    });
  }

  initializeTargetPersistence(persistence: ComposerProfileTargetPersistence) {
    this.targetPersistence = persistence;
  }

  dispose() {
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
      return cloneSettings(selection.settings);
    }
    return selection.kind === "custom" && selection.settings
      ? cloneSettings(selection.settings)
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
        await this.persistSelection(slot, { kind: "custom", settings: cloneSettings(profile) });
      }));
      return profile;
    });
  }

  selectCustom(slot: WorkbenchComposerProfileSlot, settings: WorkbenchComposerSettings) {
    void this.persistSelection(slot, { kind: "custom", settings: cloneSettings(settings) });
  }
  selectProfile(slot: WorkbenchComposerProfileSlot, profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile || ((slot.kind === "thread" || slot.kind === "draft") && profile.harness !== slot.harness)) return false;
    void this.persistSelection(slot, { kind: "profile", profileId, settings: cloneSettings(profile) });
    return true;
  }
  materializeSelection(sourceSlot: WorkbenchComposerProfileSlot, threadId: string, harness: WorkbenchHarness) {
    const selection = this.getSelection(sourceSlot);
    const settings = selection.settings;
    if (!settings || settings.harness !== harness) return;
    const slot = { harness, kind: "thread" as const, projectId: sourceSlot.projectId, threadId };
    this.installStableSelection(slot, selection.kind === "profile"
      ? { kind: "profile", profileId: selection.profileId, settings }
      : { kind: "custom", settings });
  }

  materializeDraftSelection(sourceSlot: WorkbenchComposerProfileSlot, draftId: string, harness: WorkbenchHarness, projectId: string) {
    const selection = this.getSelection(sourceSlot);
    const settings = selection.settings;
    if (settings?.harness !== harness) return;
    const slot = { draftId, harness, kind: "draft" as const, projectId };
    this.installStableSelection(slot, selection.kind === "profile"
      ? { kind: "profile", profileId: selection.profileId, settings }
      : { kind: "custom", settings });
  }

  async loadSelection(slot: WorkbenchComposerProfileSlot) {
    const key = getSlotKey(slot);
    this.slots.set(key, slot);
    const generation = this.selectionGenerations.get(key) ?? 0;
    try {
      const selection = await this.requireTargetPersistence().read(slot);
      if ((this.selectionGenerations.get(key) ?? 0) !== generation) return;
      if (selection) {
        this.installStableSelection(slot, selection, false);
      }
      else if (!this.selections[key]) {
        this.stableSelections.delete(key);
        const { [key]: _removed, ...rest } = this.selections;
        this.selections = rest;
      }
      this.error = "";
      this.publish();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Unable to read the composer profile target.");
    }
  }

  async synchronizeSelection(slot: WorkbenchComposerProfileSlot, fallbackSettings: WorkbenchComposerSettings) {
    const current = this.getSelection(slot);
    const profile = current.kind === "profile" ? this.getProfile(current.profileId) : null;
    const selection: WorkbenchComposerProfileTargetSelection = current.kind === "profile"
      ? profile
        ? {
          kind: "profile",
          profileId: current.profileId,
          settings: cloneSettings(profile),
        }
        : !this.profilesLoaded
          ? {
            kind: "profile",
            profileId: current.profileId,
            settings: cloneSettings(current.settings),
          }
          : { kind: "custom", settings: cloneSettings(current.settings) }
      : { kind: "custom", settings: cloneSettings(current.settings ?? fallbackSettings) };
    if (!await this.persistSelection(slot, selection)) {
      throw new Error(this.error || "Unable to persist the composer profile selection.");
    }
    return selection;
  }

  private async persistSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection): Promise<boolean> {
    const key = getSlotKey(slot);
    const generation = (this.selectionGenerations.get(key) ?? 0) + 1;
    this.selectionGenerations.set(key, generation);
    this.installSelection(slot, selection, false);
    this.publish();
    const priorMutation = this.selectionMutationQueues.get(key) ?? Promise.resolve();
    const operation = priorMutation.then(async () => {
      await this.requireTargetPersistence().write(slot, selection);
    });
    const queued = operation.catch(() => undefined);
    this.selectionMutationQueues.set(key, queued);
    try {
      await operation;
      this.stableSelections.set(key, this.cloneTargetSelection(selection));
      this.error = "";
      this.publish();
      return true;
    } catch (error) {
      if ((this.selectionGenerations.get(key) ?? 0) === generation) {
        const stable = this.stableSelections.get(key);
        if (stable) this.installSelection(slot, stable, false);
        else {
          const { [key]: _removed, ...rest } = this.selections;
          this.selections = rest;
        }
      }
      this.fail(error instanceof Error ? error.message : "Unable to persist the composer profile selection.");
      return false;
    } finally {
      if (this.selectionMutationQueues.get(key) === queued) this.selectionMutationQueues.delete(key);
    }
  }

  private installStableSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection, publish = true) {
    this.stableSelections.set(getSlotKey(slot), this.cloneTargetSelection(selection));
    this.installSelection(slot, selection, publish);
  }

  private cloneTargetSelection(selection: WorkbenchComposerProfileTargetSelection): WorkbenchComposerProfileTargetSelection {
    return selection.kind === "profile"
      ? { kind: "profile", profileId: selection.profileId, settings: cloneSettings(selection.settings) }
      : { kind: "custom", settings: cloneSettings(selection.settings) };
  }

  private installSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileSelection, publish = true) {
    const key = getSlotKey(slot);
    this.slots.set(key, slot);
    this.selections = {
      ...this.selections,
      [key]: selection.kind === "profile"
        ? { kind: "profile", profileId: selection.profileId, settings: cloneSettings(selection.settings) }
        : selection.settings ? { kind: "custom", settings: cloneSettings(selection.settings) } : EMPTY_CUSTOM_SELECTION,
    };
    if (publish) this.publish();
  }

  private readSelectionSlots(): Array<{
    selection: WorkbenchComposerProfileSelection;
    slot: WorkbenchComposerProfileSlot;
  }> {
    return Object.entries(this.selections).flatMap(([key, selection]) => {
      const slot = this.slots.get(key);
      return slot ? [{ selection, slot }] : [];
    });
  }

  private requirePersistence() {
    if (!this.persistence) throw new Error("Composer profiles are not connected to the daemon.");
    return this.persistence;
  }

  private requireTargetPersistence() {
    if (!this.targetPersistence) throw new Error("Composer profile targets are not connected to the daemon.");
    return this.targetPersistence;
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
