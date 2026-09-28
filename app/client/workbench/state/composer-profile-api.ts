/*
 * Exports:
 * - ComposerProfilePersistence: typed browser boundary for daemon-owned composer profiles.
 * - ComposerProfileTargetPersistence: typed browser boundary for app drafts and daemon target profile snapshots.
 * - createComposerProfilePersistence: create the daemon-backed composer-profile persistence adapter.
 * - createComposerProfileTargetPersistence: read daemon targets, app drafts, and same-daemon folder-default fallbacks.
 */
import type { WorkbenchComposerProfile, WorkbenchComposerProfileMutation, WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection } from "workbench-shared/types";
import type { WorkbenchComposerProfileSlot } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchPresentationClient from "./WorkbenchPresentationClient";

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
      ? await daemon.profiles.delete({ profileId: mutation.profileId })
      : await daemon.profiles.upsert({ profile: mutation.profile, ...(mutation.changes ? { changes: mutation.changes } : {}) }),
    read: async () => await daemon.profiles.read(),
  };
}

export function createComposerProfileTargetPersistence(
  daemon: Pick<WorkbenchDaemonClient, "profiles">,
  appDrafts: WorkbenchPresentationClient,
  daemonId: DaemonId,
): ComposerProfileTargetPersistence {
  return {
    read: async (slot) => {
      if (slot.kind === "draft") {
        await appDrafts.ready();
        return appDrafts.draft(slot.draftId)?.selection ?? null;
      }
      const own = (await daemon.profiles.target.read({ slot })).selection;
      if (own || slot.kind !== "new-thread") return own;
      const presentation = await appDrafts.ready();
      const location = presentation.locations.find(item =>
        item.target.daemonId === daemonId && item.target.projectId === slot.projectId);
      if (!location) return null;
      const ownDefault = presentation.defaults.find(item =>
        item.target.daemonId === daemonId && item.target.projectId === slot.projectId);
      if (ownDefault) return ownDefault.selection;
      const source = presentation.defaults
        .filter(item => item.target.daemonId === location.target.daemonId
          && presentation.locations.some(candidate =>
            candidate.logicalProjectId === location.logicalProjectId
            && candidate.target.daemonId === item.target.daemonId
            && candidate.target.projectId === item.target.projectId))
        .sort((left, right) => right.revision - left.revision)[0];
      if (!source) return null;
      const selection = source.selection;
      if (selection.kind === "custom") {
        return selection.settings.agentSource === "project"
          ? { kind: "custom", settings: { ...selection.settings, agentPath: null, agentSource: null } }
          : selection;
      }
      const profile = (await daemon.profiles.read()).profiles.find(item => item.id === selection.profileId);
      return profile?.scope.kind === "global" ? selection
        : { kind: "custom", settings: {
          ...selection.settings,
          ...(selection.settings.agentSource === "project" ? { agentPath: null, agentSource: null } : {}),
        } };
    },
    write: async (slot, selection) => {
      if (slot.kind === "draft") {
        await appDrafts.ready();
        const draft = appDrafts.draft(slot.draftId);
        if (!draft || draft.phase !== "unsent") throw new Error("This unsent draft is unavailable.");
        await appDrafts.putDraft({
          id: draft.id, logicalProjectId: draft.logicalProjectId, target: draft.target,
          prompt: draft.prompt, selection, updatedAt: Date.now(),
        });
        return;
      }
      await daemon.profiles.target.set({ selection, slot });
    },
  };
}
