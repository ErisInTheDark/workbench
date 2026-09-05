/*
 * Exports:
 * - ComposerProfilePersistence: typed browser boundary for daemon-owned composer profiles. Keywords: composer, profile, daemon, api.
 * - ComposerProfileTargetPersistence: typed browser boundary for daemon-owned target profile snapshots. Keywords: composer, profile, target, daemon.
 * - createComposerProfilePersistence: create the daemon-backed composer-profile persistence adapter. Keywords: composer, profile, daemon, boundary.
 * - createComposerProfileTargetPersistence: create the daemon-backed target-profile persistence adapter. Keywords: composer, profile, target, daemon.
 */
import type { WorkbenchComposerProfile, WorkbenchComposerProfileMutation, WorkbenchComposerProfileSlot, WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

export interface ComposerProfilePersistence {
  mutate: (mutation: WorkbenchComposerProfileMutation) => Promise<WorkbenchComposerProfileStorePayload>;
  read: () => Promise<WorkbenchComposerProfileStorePayload>;
}

export interface ComposerProfileTargetPersistence {
  read(slot: WorkbenchComposerProfileSlot): Promise<WorkbenchComposerProfileTargetSelection | null>;
  write(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection): Promise<void>;
}

export function createComposerProfilePersistence(daemon: WorkbenchDaemonClient): ComposerProfilePersistence {
  return {
    mutate: async (mutation) => mutation.kind === "delete"
      ? await daemon.request("profiles/delete", { profileId: mutation.profileId })
      : await daemon.request("profiles/upsert", { profile: mutation.profile, ...(mutation.changes ? { changes: mutation.changes } : {}) }),
    read: async () => await daemon.request("profiles/read", {}),
  };
}

export function createComposerProfileTargetPersistence(daemon: WorkbenchDaemonClient): ComposerProfileTargetPersistence {
  return {
    read: async (slot) => (await daemon.request("profiles/target/read", { slot })).selection,
    write: async (slot, selection) => { await daemon.request("profiles/target/set", { selection, slot }); },
  };
}
