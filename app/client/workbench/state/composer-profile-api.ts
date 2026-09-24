/*
 * Exports:
 * - ComposerProfilePersistence: typed browser boundary for daemon-owned composer profiles.
 * - ComposerProfileTargetPersistence: typed browser boundary for daemon-owned target profile snapshots.
 * - createComposerProfilePersistence: create the daemon-backed composer-profile persistence adapter.
 * - createComposerProfileTargetPersistence: use app-owned selections for unsent drafts, daemon targets otherwise.
 */
import type { WorkbenchComposerProfile, WorkbenchComposerProfileMutation, WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection } from "workbench-shared/types";
import type { WorkbenchComposerProfileSlot } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { DraftId, ProjectId } from "workbench-shared/workbench/identity";
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
  flushDraft: (projectId: ProjectId, draftId: DraftId) => Promise<void>,
  appDrafts: WorkbenchPresentationClient | null | false = false,
): ComposerProfileTargetPersistence {
  return {
    read: async (slot) => {
      if (slot.kind === "draft" && appDrafts !== false) {
        if (!appDrafts) throw new Error("App draft presentation state is unavailable.");
        return appDrafts.draft(slot.draftId)?.selection ?? null;
      }
      if (slot.kind === "draft") await flushDraft(slot.projectId, slot.draftId);
      return (await daemon.profiles.target.read({ slot })).selection;
    },
    write: async (slot, selection) => {
      if (slot.kind === "draft" && appDrafts !== false) {
        if (!appDrafts) throw new Error("App draft presentation state is unavailable.");
        const draft = appDrafts.draft(slot.draftId);
        if (!draft || draft.phase !== "unsent") throw new Error("This unsent draft is unavailable.");
        await appDrafts.putDraft({
          id: draft.id, logicalProjectId: draft.logicalProjectId, target: draft.target,
          prompt: draft.prompt, selection, updatedAt: Date.now(),
        });
        return;
      }
      if (slot.kind === "draft") await flushDraft(slot.projectId, slot.draftId);
      await daemon.profiles.target.set({ selection, slot });
    },
  };
}
