/*
 * Exports:
 * - ComposerProfilePersistence: typed browser boundary for daemon-owned composer profiles. Keywords: composer, profile, daemon, api.
 * - createComposerProfilePersistence: create the daemon-backed composer-profile persistence adapter. Keywords: composer, profile, daemon, boundary.
 */
import type { WorkbenchComposerProfile, WorkbenchComposerProfileMutation, WorkbenchComposerProfileStorePayload } from "../../types";
import type WorkbenchDaemonClient from "../daemon/WorkbenchDaemonClient";

export interface ComposerProfilePersistence {
  mutate: (mutation: WorkbenchComposerProfileMutation) => Promise<WorkbenchComposerProfileStorePayload>;
  read: () => Promise<WorkbenchComposerProfileStorePayload>;
}

export function createComposerProfilePersistence(daemon: WorkbenchDaemonClient): ComposerProfilePersistence {
  return {
    mutate: async (mutation) => mutation.kind === "delete"
      ? await daemon.request("profiles/delete", { profileId: mutation.profileId })
      : await daemon.request("profiles/upsert", { profile: mutation.profile }),
    read: async () => await daemon.request("profiles/read", {}),
  };
}
