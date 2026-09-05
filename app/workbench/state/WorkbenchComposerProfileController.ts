/*
 * Exports:
 * - default WorkbenchComposerProfileController: own daemon profile definitions and guarded daemon-target projections. Keywords: composer, profile, controller, daemon, projection.
 * - WorkbenchComposerProfileSnapshot: immutable React-facing profile, selection, and failure snapshot. Keywords: composer, profile, snapshot, error.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerProfileSelection,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  ThreadPayload,
} from "workbench-shared/types";
import type { ComposerProfilePersistence, ComposerProfileTargetPersistence } from "./composer-profile-api";
import {
  normalizeComposerProfile,
} from "workbench-shared/workbench/state/composer-profile-state";

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
  private profileGeneration = 0;
  private stableProfileGeneration = 0;
  private stableProfiles: WorkbenchComposerProfile[] = [];
  private profiles: WorkbenchComposerProfile[] = [];
  private readonly selectionGenerations = new Map<string, number>();
  private readonly slots = new Map<string, WorkbenchComposerProfileSlot>();
  private readonly stableSelections = new Map<string, { generation: number; selection: WorkbenchComposerProfileTargetSelection }>();
  private selections: Record<string, WorkbenchComposerProfileSelection> = {};
  private snapshot: WorkbenchComposerProfileSnapshot;
  private targetPersistence: ComposerProfileTargetPersistence | null = null;

  constructor() {
    this.snapshot = this.createSnapshot();
  }

  async initializePersistence(persistence: ComposerProfilePersistence) {
    this.persistence = persistence;
    const generation = ++this.profileGeneration;
    try {
      const payload = await persistence.read();
      if (generation !== this.profileGeneration) return;
      this.profiles = [...payload.profiles];
      this.stableProfiles = this.profiles;
      this.stableProfileGeneration = generation;
      this.error = "";
      this.publish();
    } catch (error) {
      if (generation === this.profileGeneration) this.fail(error instanceof Error ? error.message : "Unable to read composer profiles.");
    }
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
  getSelectedProfile(slot: WorkbenchComposerProfileSlot) { const selection = this.getSelection(slot); return selection.kind === "profile" ? this.getProfile(selection.profileId) : null; }
  getVisibleProfiles(projectId: string, harness?: WorkbenchHarness | null) {
    return this.profiles.filter((profile) => (!harness || profile.harness === harness) && (profile.scope.kind === "global" || profile.scope.projectId === projectId));
  }

  resolveSettings(slot: WorkbenchComposerProfileSlot) {
    const selection = this.getSelection(slot);
    return selection.settings ? cloneSettings(selection.settings) : null;
  }

  resolveThread(slot: WorkbenchComposerProfileSlot, thread: ThreadPayload) {
    const settings = this.resolveSettings(slot);
    return settings ? {
      ...thread,
      agentPath: settings.agentPath,
      harness: settings.harness,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      serviceTier: settings.serviceTier,
      source: thread.isDraft ? settings.harness : thread.source,
    } : { ...thread, agentPath: null, model: null, reasoningEffort: null, serviceTier: null };
  }

  async createProfile(input: Omit<WorkbenchComposerProfile, "createdAt" | "id" | "updatedAt">) {
    const now = Date.now();
    const profile = normalizeComposerProfile({ ...input, createdAt: now, id: createProfileId(), updatedAt: now });
    if (!profile) return this.fail("Profile model and scope are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") return this.fail("Profiles using a project agent cannot be global.");
    return await this.persistProfileMutation({ kind: "upsert", profile }, [...this.profiles, profile])
      ? this.getProfile(profile.id) : null;
  }

  async updateProfile(profileId: string, update: Partial<Omit<WorkbenchComposerProfile, "createdAt" | "harness" | "id">>) {
    const existing = this.getProfile(profileId);
    if (!existing) return null;
    const profile = normalizeComposerProfile({ ...existing, ...update, createdAt: existing.createdAt, harness: existing.harness, id: existing.id, updatedAt: Date.now() });
    if (!profile) return this.fail("Profile name and model are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") return this.fail("Profiles using a project agent cannot be global.");
    const { updatedAt: _updatedAt, ...changes } = update;
    return await this.persistProfileMutation({ kind: "upsert", profile, changes }, this.profiles.map((entry) => entry.id === profileId ? profile : entry))
      ? this.getProfile(profileId) : null;
  }

  async deleteProfile(profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    return await this.persistProfileMutation({ kind: "delete", profileId }, this.profiles.filter((entry) => entry.id !== profileId))
      ? profile : null;
  }

  selectCustom(slot: WorkbenchComposerProfileSlot, settings: WorkbenchComposerSettings) {
    return this.persistSelection(slot, { kind: "custom", settings: cloneSettings(settings) });
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
    const generation = (this.selectionGenerations.get(key) ?? 0) + 1;
    this.selectionGenerations.set(key, generation);
    try {
      const selection = await this.requireTargetPersistence().read(slot);
      if ((this.selectionGenerations.get(key) ?? 0) !== generation) return;
      if (selection) {
        this.installStableSelection(slot, selection, false);
      }
      else {
        this.stableSelections.delete(key);
        const { [key]: _removed, ...rest } = this.selections;
        this.selections = rest;
      }
      this.error = "";
      this.publish();
    } catch (error) {
      if (this.selectionGenerations.get(key) !== generation) return;
      const { [key]: _removed, ...rest } = this.selections;
      this.selections = rest;
      this.fail(error instanceof Error ? error.message : "Unable to read the composer profile target.");
    }
  }

  private async persistSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection): Promise<boolean> {
    const key = getSlotKey(slot);
    const generation = (this.selectionGenerations.get(key) ?? 0) + 1;
    this.selectionGenerations.set(key, generation);
    this.installSelection(slot, selection, false);
    this.publish();
    try {
      const persistence = this.requireTargetPersistence();
      await persistence.write(slot, selection);
      const acknowledged = await persistence.read(slot);
      if (!acknowledged) throw new Error("The daemon composer profile target is unavailable.");
      if (generation >= (this.stableSelections.get(key)?.generation ?? 0)) {
        this.stableSelections.set(key, { generation, selection: this.cloneTargetSelection(acknowledged) });
      }
      if (this.selectionGenerations.get(key) !== generation) return true;
      this.installSelection(slot, acknowledged, false);
      this.error = "";
      this.publish();
      return true;
    } catch (error) {
      if ((this.selectionGenerations.get(key) ?? 0) === generation) {
        const stable = this.stableSelections.get(key);
        if (stable) this.installSelection(slot, stable.selection, false);
        else {
          const { [key]: _removed, ...rest } = this.selections;
          this.selections = rest;
        }
      }
      if (this.selectionGenerations.get(key) === generation) this.fail(error instanceof Error ? error.message : "Unable to persist the composer profile selection.");
      return false;
    }
  }

  private installStableSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection, publish = true) {
    const key = getSlotKey(slot);
    const generation = (this.selectionGenerations.get(key) ?? 0) + 1;
    this.selectionGenerations.set(key, generation);
    this.stableSelections.set(key, { generation, selection: this.cloneTargetSelection(selection) });
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

  private requirePersistence() {
    if (!this.persistence) throw new Error("Composer profiles are not connected to the daemon.");
    return this.persistence;
  }

  private requireTargetPersistence() {
    if (!this.targetPersistence) throw new Error("Composer profile targets are not connected to the daemon.");
    return this.targetPersistence;
  }

  private async persistProfileMutation(mutation: WorkbenchComposerProfileMutation, optimistic: WorkbenchComposerProfile[]) {
    const generation = ++this.profileGeneration;
    this.profiles = optimistic;
    this.publish();
    try {
      const payload = await this.requirePersistence().mutate(mutation);
      if (generation >= this.stableProfileGeneration) {
        this.stableProfileGeneration = generation;
        this.stableProfiles = [...payload.profiles];
      }
      if (generation !== this.profileGeneration) return true;
      this.profiles = [...payload.profiles];
      this.error = "";
      this.publish();
      await Promise.all([...this.slots.values()].map((slot) => this.loadSelection(slot)));
      return true;
    } catch (error) {
      if (generation === this.profileGeneration) {
        this.profiles = this.stableProfiles;
        this.fail(error instanceof Error ? error.message : "Unable to persist composer profiles.");
      }
      return false;
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
