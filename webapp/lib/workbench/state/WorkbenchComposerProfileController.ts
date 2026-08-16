/*
 * Exports:
 * - default WorkbenchComposerProfileController: own browser composer selections, optimistic durable profile state, migration, and mutation outbox. Keywords: composer, profile, controller, persistence, migration, outbox.
 * - WorkbenchComposerProfileSnapshot: immutable React-facing profile and selection snapshot. Keywords: composer, profile, snapshot.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerProfileSelection,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  ThreadPayload,
} from "../../types";
import type { ComposerProfilePersistence } from "./composer-profile-api";
import {
  applyComposerProfileMutation,
  COMPOSER_PROFILE_MIGRATION_KEY,
  COMPOSER_PROFILE_STORAGE_KEY,
  type ComposerProfilePersistedState,
  type ComposerProfileStorage,
  normalizeComposerProfile,
  normalizeComposerProfileState,
} from "./composer-profile-state";

const EMPTY_CUSTOM_SELECTION: WorkbenchComposerProfileSelection = { kind: "custom" };

export interface WorkbenchComposerProfileSnapshot {
  profiles: readonly WorkbenchComposerProfile[];
  selections: Readonly<Record<string, WorkbenchComposerProfileSelection>>;
}

function createProfileId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `profile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readState(storage: ComposerProfileStorage | null) {
  if (!storage) return normalizeComposerProfileState(null);
  try {
    return normalizeComposerProfileState(JSON.parse(storage.getItem(COMPOSER_PROFILE_STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeComposerProfileState(null);
  }
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
  private listeners = new Set<() => void>();
  private persistence: ComposerProfilePersistence | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private state: ComposerProfilePersistedState;
  private snapshot: WorkbenchComposerProfileSnapshot;
  private readonly storage: ComposerProfileStorage | null;

  constructor(storage?: ComposerProfileStorage | null) {
    this.storage = storage === undefined ? typeof window !== "undefined" ? window.localStorage : null : storage;
    this.state = readState(this.storage);
    this.snapshot = this.createSnapshot();
    if (typeof window !== "undefined" && this.storage === window.localStorage) window.addEventListener("storage", this.handleStorage);
  }

  async initializePersistence(persistence: ComposerProfilePersistence) {
    this.persistence = persistence;
    const shouldImport = this.storage?.getItem(COMPOSER_PROFILE_MIGRATION_KEY) !== "complete";
    const payload = shouldImport
      ? await persistence.importLegacy(this.state.profiles)
      : await persistence.read();
    this.commit({ ...this.state, profiles: payload.profiles });
    if (shouldImport) this.storage?.setItem(COMPOSER_PROFILE_MIGRATION_KEY, "complete");
    this.flushPendingMutations();
  }

  dispose() {
    this.listeners.clear();
    if (typeof window !== "undefined" && this.storage === window.localStorage) window.removeEventListener("storage", this.handleStorage);
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  getSelection(slot: WorkbenchComposerProfileSlot) { return this.state.selections[getSlotKey(slot)] ?? EMPTY_CUSTOM_SELECTION; }
  getProfile(profileId: string) { return this.state.profiles.find((profile) => profile.id === profileId) ?? null; }
  getProfileReasoningEffort(profileId: string, harness: WorkbenchHarness) {
    const profile = this.getProfile(profileId);
    return profile?.harness === harness ? profile.reasoningEffort : null;
  }
  getSelectedProfile(slot: WorkbenchComposerProfileSlot) { const selection = this.getSelection(slot); return selection.kind === "profile" ? this.getProfile(selection.profileId) : null; }
  getVisibleProfiles(projectId: string, harness?: WorkbenchHarness | null) {
    return this.state.profiles.filter((profile) => (!harness || profile.harness === harness) && (profile.scope.kind === "global" || profile.scope.projectId === projectId));
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

  createProfile(input: Omit<WorkbenchComposerProfile, "createdAt" | "id" | "updatedAt">) {
    const now = Date.now();
    const profile = normalizeComposerProfile({ ...input, createdAt: now, id: createProfileId(), updatedAt: now });
    if (!profile) throw new Error("Profile model and scope are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") throw new Error("Profiles using a project agent cannot be global.");
    this.applyMutation({ kind: "upsert", profile });
    return profile;
  }

  updateProfile(profileId: string, update: Partial<Omit<WorkbenchComposerProfile, "createdAt" | "harness" | "id">>) {
    const existing = this.getProfile(profileId);
    if (!existing) return null;
    const profile = normalizeComposerProfile({ ...existing, ...update, createdAt: existing.createdAt, harness: existing.harness, id: existing.id, updatedAt: Date.now() });
    if (!profile) throw new Error("Profile name and model are required.");
    if (profile.scope.kind === "global" && profile.agentSource === "project") throw new Error("Profiles using a project agent cannot be global.");
    this.applyMutation({ kind: "upsert", profile });
    return profile;
  }

  deleteProfile(profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile) return;
    const selections = Object.fromEntries(Object.entries(this.state.selections).map(([key, selection]) => [
      key,
      selection.kind === "profile" && selection.profileId === profileId ? { kind: "custom" as const, pendingSettings: cloneSettings(profile) } : selection,
    ]));
    this.state = { ...this.state, selections };
    this.applyMutation({ kind: "delete", profileId });
  }

  selectCustom(slot: WorkbenchComposerProfileSlot, pendingSettings?: WorkbenchComposerSettings) { this.setSelection(slot, pendingSettings ? { kind: "custom", pendingSettings: cloneSettings(pendingSettings) } : EMPTY_CUSTOM_SELECTION); }
  selectProfile(slot: WorkbenchComposerProfileSlot, profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile || ((slot.kind === "thread" || slot.kind === "draft") && profile.harness !== slot.harness)) return false;
    this.setSelection(slot, { kind: "profile", profileId });
    return true;
  }
  acknowledgePendingSettings(slot: WorkbenchComposerProfileSlot) { const selection = this.getSelection(slot); if (selection.kind === "custom" && selection.pendingSettings) this.setSelection(slot, EMPTY_CUSTOM_SELECTION); }
  materializeSelection(sourceSlot: WorkbenchComposerProfileSlot, threadId: string, harness: WorkbenchHarness) {
    const selection = this.getSelection(sourceSlot);
    if (selection.kind === "profile" && this.getProfile(selection.profileId)?.harness === harness) this.setSelection({ harness, kind: "thread", threadId }, selection);
  }

  materializeDraftSelection(sourceSlot: WorkbenchComposerProfileSlot, draftId: string, harness: WorkbenchHarness, projectId: string) {
    const selection = this.getSelection(sourceSlot);
    if (selection.kind === "profile" && this.getProfile(selection.profileId)?.harness === harness) {
      this.setSelection({ draftId, harness, kind: "draft", projectId }, selection);
    } else if (selection.kind === "custom" && selection.pendingSettings?.harness === harness) {
      this.setSelection({ draftId, harness, kind: "draft", projectId }, selection);
    }
  }

  private setSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileSelection) {
    const selections = { ...this.state.selections };
    const key = getSlotKey(slot);
    if (selection.kind === "custom" && !selection.pendingSettings) delete selections[key]; else selections[key] = selection;
    this.commit({ ...this.state, selections });
  }

  private applyMutation(mutation: WorkbenchComposerProfileMutation) {
    this.commit({
      ...this.state,
      pendingMutations: [...this.state.pendingMutations, mutation],
      profiles: applyComposerProfileMutation(this.state.profiles, mutation),
    });
    this.flushPendingMutations();
  }

  private flushPendingMutations() {
    if (!this.persistence) return;
    this.persistenceQueue = this.persistenceQueue.catch(() => undefined).then(async () => {
      while (this.persistence && this.state.pendingMutations.length) {
        const mutation = this.state.pendingMutations[0];
        const payload = await this.persistence.mutate(mutation);
        this.commit({ ...this.state, pendingMutations: this.state.pendingMutations.slice(1), profiles: payload.profiles });
      }
    });
  }

  private commit(state: ComposerProfilePersistedState) {
    this.state = state;
    this.persistLocalState();
    this.listeners.forEach((listener) => listener());
  }

  private persistLocalState() {
    this.snapshot = this.createSnapshot();
    try { this.storage?.setItem(COMPOSER_PROFILE_STORAGE_KEY, JSON.stringify(this.state)); } catch { /* Live state remains usable. */ }
  }
  private createSnapshot(): WorkbenchComposerProfileSnapshot { return { profiles: this.state.profiles, selections: this.state.selections }; }
  private handleStorage = (event: StorageEvent) => {
    if (event.key !== COMPOSER_PROFILE_STORAGE_KEY) return;
    this.state = readState(this.storage);
    this.snapshot = this.createSnapshot();
    this.listeners.forEach((listener) => listener());
    this.flushPendingMutations();
  };
}
