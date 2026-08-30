/*
 * Exports:
 * - default WorkbenchComposerProfileStore: atomically own durable user-visible composer profiles for UI and subagent consumers. Keywords: orchestrator, composer, profile, durable, atomic.
 */
import path from "node:path";

import type { WorkbenchComposerProfile, WorkbenchComposerProfileMutation, WorkbenchComposerProfileStorePayload } from "../lib/types";
import {
  applyComposerProfileMutation,
  normalizeComposerProfile,
  normalizeComposerProfileMutation,
} from "../lib/workbench/state/composer-profile-state";
import AtomicJsonStore from "./AtomicJsonStore";

interface StoredProfiles {
  profiles: Record<string, WorkbenchComposerProfile>;
  version: 1;
}

const EMPTY_STORE: StoredProfiles = { profiles: {}, version: 1 };

function normalizeStore(value: unknown): StoredProfiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_STORE;
  const profilesValue = (value as { profiles?: unknown }).profiles;
  if (!profilesValue || typeof profilesValue !== "object" || Array.isArray(profilesValue)) return EMPTY_STORE;
  const profiles = Object.values(profilesValue).flatMap((profile) => normalizeComposerProfile(profile) ?? []);
  return { profiles: Object.fromEntries(profiles.map((profile) => [profile.id, profile])), version: 1 };
}

function payload(store: StoredProfiles): WorkbenchComposerProfileStorePayload {
  return { profiles: Object.values(store.profiles).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)) };
}

export default class WorkbenchComposerProfileStore {
  private readonly filePath: string;
  private readonly jsonStore: AtomicJsonStore;

  constructor(storageRoot: string, jsonStore = new AtomicJsonStore()) {
    this.filePath = path.join(storageRoot, ".workbench", "runtime", "composer-profiles.json");
    this.jsonStore = jsonStore;
  }

  async read() {
    return payload(normalizeStore(await this.jsonStore.read(this.filePath, EMPTY_STORE)));
  }

  async mutate(value: unknown) {
    const mutation = normalizeComposerProfileMutation(value);
    if (!mutation) throw new Error("A valid composer profile mutation is required.");
    await this.jsonStore.update(this.filePath, EMPTY_STORE, (rawCurrent) => {
      const current = normalizeStore(rawCurrent);
      const profiles = applyComposerProfileMutation(Object.values(current.profiles), mutation as WorkbenchComposerProfileMutation);
      return { profiles: Object.fromEntries(profiles.map((profile) => [profile.id, profile])), version: 1 as const };
    });
    return await this.read();
  }
}
