/**
 * Exports:
 * - default WorkbenchComposerProfileController: own browser-global composer profiles, scoped visibility, and custom/profile slot selections. Keywords: composer, profile, ribbon, persistence, scope.
 * - WorkbenchComposerProfileSnapshot: immutable React-facing snapshot of profiles and persisted slot selections. Keywords: composer, profile, snapshot.
 */

import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileSelection,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  ThreadPayload,
} from "../../types";
import { normalizeWorkbenchAgentPath } from "../agent-paths";

const COMPOSER_PROFILE_STORAGE_KEY = "workbench:composer-profiles";
const EMPTY_CUSTOM_SELECTION: WorkbenchComposerProfileSelection = { kind: "custom" };

interface PersistedComposerProfileState {
  profiles: WorkbenchComposerProfile[];
  selections: Record<string, WorkbenchComposerProfileSelection>;
  version: 1;
}

interface ComposerProfileStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface WorkbenchComposerProfileSnapshot {
  profiles: readonly WorkbenchComposerProfile[];
  selections: Readonly<Record<string, WorkbenchComposerProfileSelection>>;
}

function createProfileId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `profile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizeHarness(value: unknown): WorkbenchHarness | null {
  return value === "codex" || value === "copilot" || value === "opencode" ? value : null;
}

function normalizeSettings(value: unknown): WorkbenchComposerSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<WorkbenchComposerSettings>;
  const harness = normalizeHarness(candidate.harness);
  const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
  if (!harness || !model) {
    return null;
  }

  const agentPath = normalizeWorkbenchAgentPath(typeof candidate.agentPath === "string" ? candidate.agentPath : null);
  const agentSource = agentPath && (candidate.agentSource === "library" || candidate.agentSource === "project")
    ? candidate.agentSource
    : null;

  return {
    agentPath,
    agentSource,
    harness,
    model,
    reasoningEffort: typeof candidate.reasoningEffort === "string" && candidate.reasoningEffort.trim()
      ? candidate.reasoningEffort.trim()
      : null,
    serviceTier: harness === "codex" && candidate.serviceTier === "fast" ? "fast" : null,
  };
}

function normalizeProfile(value: unknown): WorkbenchComposerProfile | null {
  const settings = normalizeSettings(value);
  if (!settings || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<WorkbenchComposerProfile>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const scope = candidate.scope?.kind === "global"
    ? { kind: "global" as const }
    : candidate.scope?.kind === "project" && typeof candidate.scope.projectId === "string" && candidate.scope.projectId.trim()
      ? { kind: "project" as const, projectId: candidate.scope.projectId.trim() }
      : null;
  if (!id || !name || !scope) {
    return null;
  }

  const createdAt = Number.isFinite(candidate.createdAt) ? Math.max(0, Math.trunc(candidate.createdAt!)) : Date.now();
  const updatedAt = Number.isFinite(candidate.updatedAt) ? Math.max(createdAt, Math.trunc(candidate.updatedAt!)) : createdAt;
  return {
    ...settings,
    createdAt,
    id,
    name,
    scope,
    updatedAt,
  };
}

function normalizeSelection(value: unknown): WorkbenchComposerProfileSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<WorkbenchComposerProfileSelection>;
  if (candidate.kind === "profile" && typeof candidate.profileId === "string" && candidate.profileId.trim()) {
    return { kind: "profile", profileId: candidate.profileId.trim() };
  }

  if (candidate.kind === "custom") {
    const pendingSettings = "pendingSettings" in candidate ? normalizeSettings(candidate.pendingSettings) : null;
    return pendingSettings ? { kind: "custom", pendingSettings } : EMPTY_CUSTOM_SELECTION;
  }

  return null;
}

function normalizeState(value: unknown): PersistedComposerProfileState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { profiles: [], selections: {}, version: 1 };
  }

  const candidate = value as Partial<PersistedComposerProfileState>;
  const profiles = Array.isArray(candidate.profiles)
    ? candidate.profiles.flatMap((profile) => {
      const normalized = normalizeProfile(profile);
      return normalized ? [normalized] : [];
    })
    : [];
  const selections = candidate.selections && typeof candidate.selections === "object" && !Array.isArray(candidate.selections)
    ? Object.fromEntries(Object.entries(candidate.selections).flatMap(([key, selection]) => {
      const normalized = normalizeSelection(selection);
      return key.trim() && normalized ? [[key, normalized]] : [];
    }))
    : {};

  return { profiles, selections, version: 1 };
}

function readState(storage: ComposerProfileStorage | null) {
  if (!storage) {
    return normalizeState(null);
  }

  try {
    return normalizeState(JSON.parse(storage.getItem(COMPOSER_PROFILE_STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeState(null);
  }
}

function getSlotKey(slot: WorkbenchComposerProfileSlot) {
  if (slot.kind === "thread") {
    return `thread:${slot.harness}:${slot.threadId}`;
  }

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

function settingsFromProfile(profile: WorkbenchComposerProfile) {
  return cloneSettings(profile);
}

export default class WorkbenchComposerProfileController {
  private listeners = new Set<() => void>();
  private state: PersistedComposerProfileState;
  private snapshot: WorkbenchComposerProfileSnapshot;
  private readonly storage: ComposerProfileStorage | null;

  constructor(storage?: ComposerProfileStorage | null) {
    this.storage = storage === undefined
      ? typeof window !== "undefined" ? window.localStorage : null
      : storage;
    this.state = readState(this.storage);
    this.snapshot = this.createSnapshot();
    if (typeof window !== "undefined" && this.storage === window.localStorage) {
      window.addEventListener("storage", this.handleStorage);
    }
  }

  dispose() {
    this.listeners.clear();
    if (typeof window !== "undefined" && this.storage === window.localStorage) {
      window.removeEventListener("storage", this.handleStorage);
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  getSelection(slot: WorkbenchComposerProfileSlot) {
    return this.state.selections[getSlotKey(slot)] ?? EMPTY_CUSTOM_SELECTION;
  }

  getProfile(profileId: string) {
    return this.state.profiles.find((profile) => profile.id === profileId) ?? null;
  }

  getSelectedProfile(slot: WorkbenchComposerProfileSlot) {
    const selection = this.getSelection(slot);
    return selection.kind === "profile" ? this.getProfile(selection.profileId) : null;
  }

  getVisibleProfiles(projectId: string, harness?: WorkbenchHarness | null) {
    return this.state.profiles.filter((profile) => (
      (!harness || profile.harness === harness)
      && (profile.scope.kind === "global" || profile.scope.projectId === projectId)
    ));
  }

  resolveSettings(slot: WorkbenchComposerProfileSlot, customSettings: WorkbenchComposerSettings | null) {
    const selection = this.getSelection(slot);
    if (selection.kind === "profile") {
      const profile = this.getProfile(selection.profileId);
      if (profile) {
        return settingsFromProfile(profile);
      }
    }

    return selection.kind === "custom" && selection.pendingSettings
      ? cloneSettings(selection.pendingSettings)
      : customSettings ? cloneSettings(customSettings) : null;
  }

  resolveThread(slot: WorkbenchComposerProfileSlot, thread: ThreadPayload) {
    const customSettings = thread.model
      ? {
        agentPath: thread.agentPath,
        agentSource: null,
        harness: thread.harness,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        serviceTier: thread.harness === "codex" && thread.serviceTier === "fast" ? "fast" as const : null,
      }
      : null;
    const settings = this.resolveSettings(slot, customSettings);
    return settings
      ? {
        ...thread,
        agentPath: settings.agentPath,
        harness: settings.harness,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        serviceTier: settings.serviceTier,
        source: thread.isDraft ? settings.harness : thread.source,
      }
      : thread;
  }

  createProfile(input: Omit<WorkbenchComposerProfile, "createdAt" | "id" | "updatedAt">) {
    const normalized = normalizeProfile({
      ...input,
      createdAt: Date.now(),
      id: createProfileId(),
      updatedAt: Date.now(),
    });
    if (!normalized) {
      throw new Error("Profile name and model are required.");
    }
    if (normalized.scope.kind === "global" && normalized.agentSource === "project") {
      throw new Error("Profiles using a project agent cannot be global.");
    }

    this.commit({ ...this.state, profiles: [...this.state.profiles, normalized] });
    return normalized;
  }

  updateProfile(profileId: string, update: Partial<Omit<WorkbenchComposerProfile, "createdAt" | "harness" | "id">>) {
    const existing = this.getProfile(profileId);
    if (!existing) {
      return null;
    }

    const normalized = normalizeProfile({
      ...existing,
      ...update,
      harness: existing.harness,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    });
    if (!normalized) {
      throw new Error("Profile name and model are required.");
    }
    if (normalized.scope.kind === "global" && normalized.agentSource === "project") {
      throw new Error("Profiles using a project agent cannot be global.");
    }

    this.commit({
      ...this.state,
      profiles: this.state.profiles.map((profile) => profile.id === profileId ? normalized : profile),
    });
    return normalized;
  }

  deleteProfile(profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return;
    }

    const pendingSettings = settingsFromProfile(profile);
    const selections = Object.fromEntries(Object.entries(this.state.selections).map(([key, selection]) => [
      key,
      selection.kind === "profile" && selection.profileId === profileId
        ? { kind: "custom" as const, pendingSettings: cloneSettings(pendingSettings) }
        : selection,
    ]));
    this.commit({
      ...this.state,
      profiles: this.state.profiles.filter((candidate) => candidate.id !== profileId),
      selections,
    });
  }

  selectCustom(slot: WorkbenchComposerProfileSlot, pendingSettings?: WorkbenchComposerSettings) {
    this.setSelection(slot, pendingSettings
      ? { kind: "custom", pendingSettings: cloneSettings(pendingSettings) }
      : EMPTY_CUSTOM_SELECTION);
  }

  selectProfile(slot: WorkbenchComposerProfileSlot, profileId: string) {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return false;
    }
    if (slot.kind === "thread" && profile.harness !== slot.harness) {
      return false;
    }

    this.setSelection(slot, { kind: "profile", profileId });
    return true;
  }

  acknowledgePendingSettings(slot: WorkbenchComposerProfileSlot) {
    const selection = this.getSelection(slot);
    if (selection.kind === "custom" && selection.pendingSettings) {
      this.setSelection(slot, EMPTY_CUSTOM_SELECTION);
    }
  }

  materializeSelection(sourceSlot: WorkbenchComposerProfileSlot, threadId: string, harness: WorkbenchHarness) {
    const sourceSelection = this.getSelection(sourceSlot);
    const destinationSlot: WorkbenchComposerProfileSlot = { harness, kind: "thread", threadId };
    if (sourceSelection.kind === "profile") {
      const profile = this.getProfile(sourceSelection.profileId);
      if (profile?.harness === harness) {
        this.setSelection(destinationSlot, sourceSelection);
      }
    }
  }

  private setSelection(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileSelection) {
    const selections = { ...this.state.selections };
    const key = getSlotKey(slot);
    if (selection.kind === "custom" && !selection.pendingSettings) {
      delete selections[key];
    } else {
      selections[key] = selection;
    }
    this.commit({ ...this.state, selections });
  }

  private commit(state: PersistedComposerProfileState) {
    this.state = state;
    this.snapshot = this.createSnapshot();
    try {
      this.storage?.setItem(COMPOSER_PROFILE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Browser persistence is best effort; the live controller remains usable.
    }
    this.listeners.forEach((listener) => listener());
  }

  private createSnapshot(): WorkbenchComposerProfileSnapshot {
    return {
      profiles: this.state.profiles,
      selections: this.state.selections,
    };
  }

  private handleStorage = (event: StorageEvent) => {
    if (event.key !== COMPOSER_PROFILE_STORAGE_KEY) {
      return;
    }

    this.state = readState(this.storage);
    this.snapshot = this.createSnapshot();
    this.listeners.forEach((listener) => listener());
  };
}
