/*
 * Exports:
 * - default WorkbenchComposerProfileController: own daemon profiles and guarded target projections.
 * - WorkbenchComposerProfileSnapshot: immutable profile, selection, and failure snapshot.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileChanges,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerProfileSelection,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  WorkbenchModelOption,
  ThreadPayload,
} from "workbench-shared/types";
import type { ComposerProfilePersistence, ComposerProfileTargetPersistence } from "./composer-profile-api";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadDraft } from "workbench-shared/workbench/thread/thread-state";
import { copyComposerSettings as cloneSettings } from "workbench-shared/workbench/thread/thread-profile";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
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
  private readonly selectionWrites = new Map<string, Promise<boolean>>();
  private readonly profileWrites = new Map<string, Promise<boolean>>();
  private catalogueRefresh: Promise<void> | null = null;

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

  async initializeTargetPersistence(persistence: ComposerProfileTargetPersistence) {
    this.targetPersistence = persistence;
    await Promise.all([...this.slots.values()].map((slot) => this.loadSelection(slot)));
  }

  refreshProfiles = (): Promise<void> => {
    if (this.catalogueRefresh) return this.catalogueRefresh;
    const persistence = this.persistence;
    if (!persistence || this.profileWrites.size > 0) return Promise.resolve();
    const generation = ++this.profileGeneration;
    const refresh = (async () => {
      try {
        const payload = await persistence.read();
        if (generation !== this.profileGeneration || persistence !== this.persistence) return;
        this.profiles = [...payload.profiles];
        this.stableProfiles = this.profiles;
        this.stableProfileGeneration = generation;
        this.publish();
      } catch (error) {
        if (generation === this.profileGeneration && persistence === this.persistence) {
          this.fail(error instanceof Error ? error.message : "Unable to refresh composer profiles.");
        }
      }
    })();
    const pending = refresh.finally(() => { if (this.catalogueRefresh === pending) this.catalogueRefresh = null; });
    this.catalogueRefresh = pending;
    return pending;
  };

  disconnectPersistence() {
    this.persistence = null;
    this.targetPersistence = null;
    this.profileGeneration++;
    this.catalogueRefresh = null;
    for (const [key, generation] of this.selectionGenerations) {
      this.selectionGenerations.set(key, generation + 1);
    }
  }

  dispose() {
    this.disconnectPersistence();
    this.listeners.clear();
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  hasSelection(slot: WorkbenchComposerProfileSlot) { return Object.hasOwn(this.selections, getSlotKey(slot)); }
  getSelection(slot: WorkbenchComposerProfileSlot): WorkbenchComposerProfileSelection {
    const selection = this.selections[getSlotKey(slot)] ?? EMPTY_CUSTOM_SELECTION;
    return selection.kind === "profile" && this.stableProfileGeneration > 0 && !this.getProfile(selection.profileId)
      ? { kind: "custom", settings: selection.settings }
      : selection;
  }
  getProfile(profileId: string) { return this.profiles.find((profile) => profile.id === profileId) ?? null; }
  getSelectedProfile(slot: WorkbenchComposerProfileSlot) { const selection = this.getSelection(slot); return selection.kind === "profile" ? this.getProfile(selection.profileId) : null; }
  getVisibleProfiles(projectId: string, harness?: WorkbenchHarness | null) {
    return this.profiles.filter((profile) => (!harness || profile.harness === harness) && (profile.scope.kind === "global" || profile.scope.projectId === projectId));
  }

  resolveSettings(slot: WorkbenchComposerProfileSlot) {
    const selection = this.getSelection(slot);
    const definition = this.getSelectedProfile(slot);
    return selection.settings ? cloneSettings(definition ?? selection.settings) : null;
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
      contextWindowTokens: settings.contextWindowTokens ?? null,
      source: thread.isDraft ? settings.harness : thread.source,
    } : { ...thread, agentPath: null, model: null, reasoningEffort: null, serviceTier: null, contextWindowTokens: null };
  }

  async createProfile(input: Omit<WorkbenchComposerProfile, "createdAt" | "id" | "updatedAt">) {
    const now = Date.now();
    const profile = normalizeComposerProfile({ ...input, createdAt: now, id: createProfileId(), updatedAt: now });
    if (!profile) return this.fail("Profile model and scope are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") return this.fail("Profiles using a project agent cannot be global.");
    return await this.persistProfileMutation({ kind: "upsert", profile }, [...this.profiles, profile])
      ? this.getProfile(profile.id) : null;
  }

  async updateProfile(profileId: string, update: WorkbenchComposerProfileChanges) {
    const existing = this.getProfile(profileId);
    if (!existing) return null;
    const normalized = normalizeComposerProfile({ ...existing, ...update, createdAt: existing.createdAt, harness: existing.harness, id: existing.id, updatedAt: Date.now() });
    const profile = normalized ? { ...normalized, ...(existing.lastUsedAt != null ? { lastUsedAt: existing.lastUsedAt } : {}) } : null;
    if (!profile) return this.fail("Profile name and model are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") return this.fail("Profiles using a project agent cannot be global.");
    return await this.persistProfileMutation({ kind: "upsert", profile, changes: update }, this.profiles.map((entry) => entry.id === profileId ? profile : entry))
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
  selectHarness(slot: WorkbenchComposerProfileSlot, harness: WorkbenchHarness, loadModels: () => Promise<WorkbenchModelOption[]>) {
    if (slot.kind === "thread" || this.getSelection(slot).kind === "profile") return Promise.resolve(false);
    const key = getSlotKey(slot);
    const previous = this.selectionWrites.get(key);
    const generation = this.selectionGenerations.get(key) ?? 0;
    const persistence = this.targetPersistence;
    const pending = (async () => {
      if (previous) await previous;
      try {
        const models = (await loadModels()).filter((model) => model.policyState !== "disabled");
        if (this.targetPersistence !== persistence || (this.selectionGenerations.get(key) ?? 0) !== generation) return false;
        const model = models.find((entry) => entry.isDefault) ?? models[0];
        if (!model) throw new Error("No models are available for that provider.");
        return await this.writeSelection(slot, { kind: "custom", settings: {
          agentPath: null, agentSource: null, harness, model: model.id,
          reasoningEffort: model.supportsReasoningEffort ? model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null : null,
          serviceTier: null,
          contextWindowTokens: model.contextWindow?.defaultTokens ?? null,
        } });
      } catch (error) {
        this.fail(error instanceof Error ? error.message : "Unable to change provider.");
        return false;
      }
    })();
    this.selectionWrites.set(key, pending);
    return pending.finally(() => { if (this.selectionWrites.get(key) === pending) this.selectionWrites.delete(key); });
  }
  selectProfile(slot: WorkbenchComposerProfileSlot, profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile || ((slot.kind === "thread" || slot.kind === "draft") && profile.harness !== slot.harness)) return false;
    void this.persistSelection(slot, { kind: "profile", profileId, settings: cloneSettings(profile) });
    return true;
  }

  observeSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection | null) {
    if (this.selectionWrites.has(getSlotKey(slot))) return;
    if (!selection && slot.kind === "thread") return this.loadSelection(slot);
    if (areDeeplyEqual(this.getSelection(slot), selection ?? EMPTY_CUSTOM_SELECTION)) return;
    if (selection) this.installStableSelection(slot, selection);
    else {
      this.stableSelections.delete(getSlotKey(slot));
      this.installSelection(slot, EMPTY_CUSTOM_SELECTION);
    }
  }

  async waitForSelection(slot: WorkbenchComposerProfileSlot) {
    const key = getSlotKey(slot);
    while (true) {
      // Pending deletion already previews Custom; its saved association still owns the write.
      const selection = this.selections[key] ?? EMPTY_CUSTOM_SELECTION;
      const pending = this.selectionWrites.get(key)
        ?? (selection.kind === "profile" ? this.profileWrites.get(selection.profileId) : null);
      if (!pending) return;
      if (!await pending) throw new Error(this.error || "The profile settings could not be saved.");
    }
  }
  materializeSelection(sourceSlot: WorkbenchComposerProfileSlot, threadId: WorkbenchThreadId, harness: WorkbenchHarness) {
    const selection = this.getSelection(sourceSlot);
    const settings = selection.settings;
    if (!settings || settings.harness !== harness) return;
    const slot = { harness, kind: "thread" as const, projectId: sourceSlot.projectId, threadId };
    this.installStableSelection(slot, selection.kind === "profile"
      ? { kind: "profile", profileId: selection.profileId, settings }
      : { kind: "custom", settings });
  }

  materializeDraftSelection(draft: Pick<WorkbenchThreadDraft, "draftId" | "projectId" | "profileId" | "composerSettings">) {
    const settings = draft.composerSettings;
    const slot = { draftId: draft.draftId, harness: settings.harness, kind: "draft" as const, projectId: draft.projectId };
    this.installStableSelection(slot, draft.profileId
      ? { kind: "profile", profileId: draft.profileId, settings }
      : { kind: "custom", settings });
  }

  async loadSelection(slot: WorkbenchComposerProfileSlot) {
    const key = getSlotKey(slot);
    this.slots.set(key, slot);
    const pending = this.selectionWrites.get(key);
    if (pending) await pending;
    const persistence = this.targetPersistence;
    if (!persistence) return;
    const generation = (this.selectionGenerations.get(key) ?? 0) + 1;
    this.selectionGenerations.set(key, generation);
    // Initial catalogue loading must not hide usable target settings. Later target
    // loads refresh definitions, fenced against concurrent catalogue edits/loads.
    const catalogue = this.persistence && this.stableProfileGeneration > 0 && this.profileWrites.size === 0
      ? this.persistence : null;
    const profileGeneration = catalogue ? ++this.profileGeneration : this.profileGeneration;
    try {
      const [selection, definitions] = await Promise.all([
        persistence.read(slot),
        catalogue?.read() ?? Promise.resolve(null),
      ]);
      const refreshedCatalogue = definitions && this.profileGeneration === profileGeneration;
      if (refreshedCatalogue) {
        this.profiles = [...definitions.profiles];
        this.stableProfiles = this.profiles;
        this.stableProfileGeneration = profileGeneration;
      }
      if ((this.selectionGenerations.get(key) ?? 0) !== generation) {
        if (refreshedCatalogue) this.publish();
        return;
      }
      if (selection) {
        this.installStableSelection(slot, selection, false);
      }
      else {
        this.stableSelections.delete(key);
        this.installSelection(slot, EMPTY_CUSTOM_SELECTION, false);
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

  private persistSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection): Promise<boolean> {
    const key = getSlotKey(slot);
    const pending = this.writeSelection(slot, selection, this.selectionWrites.get(key));
    this.selectionWrites.set(key, pending);
    return pending.finally(() => { if (this.selectionWrites.get(key) === pending) this.selectionWrites.delete(key); });
  }

  private async writeSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection, previous?: Promise<boolean>): Promise<boolean> {
    const key = getSlotKey(slot);
    const generation = (this.selectionGenerations.get(key) ?? 0) + 1;
    this.selectionGenerations.set(key, generation);
    this.installSelection(slot, selection, false);
    this.publish();
    try {
      const persistence = this.requireTargetPersistence();
      await previous;
      if (this.targetPersistence !== persistence) throw new Error("Composer profile connection changed before the settings could be saved.");
      await persistence.write(slot, selection);
      const destination = slot.kind === "draft" ? { ...slot, harness: selection.settings.harness } : slot;
      const acknowledged = await persistence.read(destination);
      if (this.targetPersistence !== persistence) return false;
      if (!acknowledged) throw new Error("The daemon composer profile target is unavailable.");
      if (generation >= (this.stableSelections.get(key)?.generation ?? 0)) {
        this.stableSelections.set(key, { generation, selection: this.cloneTargetSelection(acknowledged) });
      }
      if (this.selectionGenerations.get(key) !== generation) return true;
      if (getSlotKey(destination) !== key) this.installStableSelection(destination, acknowledged, false);
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

  private persistProfileMutation(mutation: WorkbenchComposerProfileMutation, optimistic: WorkbenchComposerProfile[]) {
    const id = mutation.kind === "delete" ? mutation.profileId : mutation.profile.id;
    const pending = this.writeProfileMutation(mutation, optimistic);
    this.profileWrites.set(id, pending);
    return pending.finally(() => { if (this.profileWrites.get(id) === pending) this.profileWrites.delete(id); });
  }

  private async writeProfileMutation(mutation: WorkbenchComposerProfileMutation, optimistic: WorkbenchComposerProfile[]) {
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
