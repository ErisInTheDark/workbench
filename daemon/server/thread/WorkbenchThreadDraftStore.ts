/*
 * Exports:
 * - conformStoredWorkbenchThreadDraft: repair one persisted draft at the storage boundary.
 * - projectWorkbenchThreadDraft: project one draft into its sidebar entry.
 * - workbenchComposerProfileFromDraft: derive the draft's durable profile selection.
 * - default WorkbenchThreadDraftStore: retain imported drafts, new-thread profile, and stored draft projection.
 */

import { z } from "zod";

import type { ProjectId } from "workbench-shared/workbench/identity";
import {
  WorkbenchComposerSettingsSchema,
  WorkbenchHarnessSchema,
  WorkbenchThreadDraftSchema,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadDraft,
} from "workbench-shared/workbench/thread/thread-state";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type { WorkbenchThreadStateEntry } from "./workbench-thread-state-record";

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

}
