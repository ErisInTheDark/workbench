/*
 * Keywords: composer, profile, daemon, draft, persistence, boundary.
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

export function createComposerProfileTargetPersistence(
  daemon: Pick<WorkbenchDaemonClient, "request">,
  flushDraft: (projectId: string, draftId: string) => Promise<void>,
): ComposerProfileTargetPersistence {
  return {
    read: async (slot) => {
      if (slot.kind === "draft") await flushDraft(slot.projectId, slot.draftId);
      return (await daemon.request("profiles/target/read", { slot })).selection;
    },
    write: async (slot, selection) => {
      if (slot.kind === "draft") await flushDraft(slot.projectId, slot.draftId);
      await daemon.request("profiles/target/set", { selection, slot });
    },
  };
}
