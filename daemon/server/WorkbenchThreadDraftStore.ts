/*
 * Exports:
 * - conformStoredWorkbenchThreadDraft: repair one persisted draft at the storage boundary.
 * - projectWorkbenchThreadDraft: project one draft into its sidebar entry.
 * - workbenchComposerProfileFromDraft: derive the draft's durable profile selection.
 * - default WorkbenchThreadDraftStore: own project drafts, new-thread profile, and draft sidebar projection.
 */

import { z } from "zod";

import { getThreadDisplayDraftKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { moveWorkbenchThreadDisplayItem } from "workbench-shared/workbench/thread/thread-display-order";
import type { ProjectId } from "workbench-shared/workbench/identity";
import {
  WorkbenchComposerSettingsSchema,
  WorkbenchHarnessSchema,
  WorkbenchThreadDraftSchema,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadDraft,
  type WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type { WorkbenchThreadStateEntry } from "./workbench-thread-state-record";
import type WorkbenchProjectThreadState from "./WorkbenchProjectThreadState";

const StoredDraftIdentitySchema = z.object({
  draftId: z.uuid(),
  harness: WorkbenchHarnessSchema,
}).strip();

export function conformStoredWorkbenchThreadDraft(candidate: unknown, projectId: ProjectId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { error: new Error("Stored draft identity is missing."), success: false as const };
  }
  const { pinned, snoozed, ...draftCandidate } = candidate as Record<string, unknown>;
  const storedSettings = WorkbenchComposerSettingsSchema.safeParse(draftCandidate.composerSettings);
  const identity = StoredDraftIdentitySchema.safeParse({
    ...draftCandidate,
    harness: storedSettings.success ? storedSettings.data.harness : draftCandidate.harness,
  });
  if (!identity.success) return { error: identity.error, success: false as const };
  const composerSettings = storedSettings.success
    ? storedSettings.data
    : {
      agentPath: typeof draftCandidate.agent === "string" ? draftCandidate.agent : null,
      agentSource: null,
      harness: identity.data.harness,
      model: typeof draftCandidate.model === "string" ? draftCandidate.model : "",
      reasoningEffort: typeof draftCandidate.reasoningEffort === "string" ? draftCandidate.reasoningEffort : null,
      serviceTier: draftCandidate.serviceTier === "fast" ? "fast" as const : null,
    };
  const conformed = conformToZodSchema(WorkbenchThreadDraftSchema, { ...draftCandidate, projectId }, {
    attachments: [],
    clientUpdatedAt: 0,
    composerSettings,
    createdAt: 0,
    draftId: identity.data.draftId,
    profileId: null,
    projectId,
    prompt: "",
    updatedAt: 0,
  });
  const repairedPaths = [...conformed.repairedPaths];
  if (draftCandidate.projectId !== projectId) repairedPaths.push(["projectId"]);
  if (pinned !== undefined && typeof pinned !== "boolean") repairedPaths.push(["pinned"]);
  if (snoozed !== undefined && typeof snoozed !== "boolean") repairedPaths.push(["snoozed"]);
  return {
    draft: conformed.data,
    metadata: { archived: false as const, pinned: pinned === true, snoozed: snoozed === true },
    repairedPaths,
    success: true as const,
  };
}

export function workbenchComposerProfileFromDraft(
  draft: WorkbenchThreadDraft,
): WorkbenchComposerProfileSelectionState {
  return draft.profileId
    ? { kind: "profile", profileId: draft.profileId, settings: draft.composerSettings }
    : { kind: "custom", settings: draft.composerSettings };
}

export function projectWorkbenchThreadDraft(
  draft: WorkbenchThreadDraft,
  metadata = { archived: false as const, pinned: false, snoozed: false },
): Extract<WorkbenchThreadStateEntry, { entryKind: "draft" }> {
  return {
    activityAt: draft.updatedAt,
    draft,
    entryKind: "draft",
    metadata,
    title: draft.prompt.trim().split(/\r?\n/u).find(Boolean)?.trim().replace(/\s+/gu, " ") || "Draft",
  };
}

export default class WorkbenchThreadDraftStore {
  readonly drafts: Map<string, WorkbenchThreadDraft>;
  newThreadProfile: WorkbenchComposerProfileSelectionState | null;

  constructor(
    drafts: Iterable<readonly [string, WorkbenchThreadDraft]> = [],
    newThreadProfile: WorkbenchComposerProfileSelectionState | null = null,
  ) {
    this.drafts = new Map(drafts);
    this.newThreadProfile = newThreadProfile;
  }

  clone() {
    return new WorkbenchThreadDraftStore(this.drafts, this.newThreadProfile);
  }

  profileFromDraft(draft: WorkbenchThreadDraft): WorkbenchComposerProfileSelectionState {
    return workbenchComposerProfileFromDraft(draft);
  }

  projectEntry(
    draft: WorkbenchThreadDraft,
    metadata = { archived: false as const, pinned: false, snoozed: false },
  ): Extract<WorkbenchThreadStateEntry, { entryKind: "draft" }> {
    return projectWorkbenchThreadDraft(draft, metadata);
  }

  async upsert(
    project: WorkbenchProjectThreadState,
    projectId: ProjectId,
    draft: WorkbenchThreadDraft,
    folderId: string | undefined,
    ports: {
      beforeWrite: () => void;
      entries: (state: WorkbenchProjectThreadState) => readonly WorkbenchThreadSidebarEntry[];
      now: () => number;
      write: Parameters<WorkbenchProjectThreadState["writeSelected"]>[3]["write"];
    },
  ) {
    const current = this.drafts.get(draft.draftId);
    if (current && current.clientUpdatedAt > draft.clientUpdatedAt) {
      return { accepted: true, entry: null, revision: project.revision };
    }
    const targetFolder = folderId
      ? project.displayOrder.folders?.find((folder) => folder.folderId === folderId)
      : null;
    if (folderId && (!targetFolder || targetFolder.section === "settled")) {
      return { accepted: false, entry: null, revision: project.revision };
    }
    const timestamp = ports.now();
    const accepted = WorkbenchThreadDraftSchema.parse({
      ...draft,
      createdAt: current?.createdAt ?? timestamp,
      projectId,
      updatedAt: timestamp,
    });
    const staged = project.stage();
    staged.drafts.set(accepted.draftId, accepted);
    staged.newThreadProfile = staged.draftStore.profileFromDraft(accepted);
    const existingEntry = project.entries.get(getThreadDisplayDraftKey(accepted.draftId));
    const metadata = existingEntry?.entryKind === "draft"
      ? existingEntry.metadata
      : targetFolder
        ? {
          archived: false as const,
          pinned: targetFolder.section === "pinned",
          snoozed: targetFolder.section === "snoozed",
        }
        : undefined;
    const entry = staged.draftStore.projectEntry(accepted, metadata);
    const key = getThreadDisplayDraftKey(accepted.draftId);
    staged.entries.set(key, entry);
    if (targetFolder) {
      const displayOrder = moveWorkbenchThreadDisplayItem(
        ports.entries(staged),
        staged.displayOrder,
        targetFolder.section,
        key,
        targetFolder.folderId,
        targetFolder.threadKeys[0] ?? null,
      );
      if (!displayOrder) return { accepted: false, entry: null, revision: project.revision };
      staged.displayOrder = displayOrder;
    }
    await staged.writeSelected(projectId, [key], {
      layout: Boolean(targetFolder),
      profile: true,
    }, {
      beforeWrite: ports.beforeWrite,
      write: ports.write,
    });
    this.drafts.set(accepted.draftId, accepted);
    project.entries.set(key, entry);
    this.newThreadProfile = staged.newThreadProfile;
    if (targetFolder) project.displayOrder = staged.displayOrder;
    return { accepted: true, entry, revision: project.revision };
  }
}
