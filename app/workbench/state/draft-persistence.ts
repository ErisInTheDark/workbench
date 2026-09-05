/*
 * Keywords: draft, persistence, identity, composer, questionnaire, sidebar, materialisation.
 * Exports:
 * - ClientDraftIdentity: project-qualified client-state address.
 * - ComposerDraftTarget: existing-thread or unsent-sidebar destination.
 * - SidebarDraftPersistence: access the existing sidebar and profile owners.
 * - sidebarDraftToInput: project persisted sidebar prompt and image attachments into composer input.
 * - saveComposerDraft: merge edits and materialise eligible sidebar drafts.
 * - clearComposerDraft: remove only the captured composer destination.
 * - saveQuestionnaireDraft: merge edits into the latest questionnaire record.
 * - clearQuestionnaireDraft: remove only the captured questionnaire record.
 */
import type { WorkbenchComposerInputDraft, WorkbenchQuestionnaireDraft } from "workbench-shared/types";
import { countDraftPromptTokens, type WorkbenchThreadDraft } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchClientStateController from "./WorkbenchClientStateController";

export interface ClientDraftIdentity {
  daemonRegistrationId: string;
  projectId: string;
  threadId: string;
}

export interface SidebarDraftPersistence {
  read: (projectId: string, draftId: string) => WorkbenchThreadDraft | null;
  create: (projectId: string, draftId: string) => WorkbenchThreadDraft;
  write: (draft: WorkbenchThreadDraft, folderId?: string) => Promise<void> | void;
  remove: (projectId: string, draftId: string) => Promise<void>;
  materialize: (draft: WorkbenchThreadDraft) => void;
}

export type ComposerDraftTarget =
  | (ClientDraftIdentity & { kind: "thread" })
  | { kind: "sidebar"; projectId: string; draftId: string; isNew: boolean; folderId?: string; owner: SidebarDraftPersistence };

export function sidebarDraftToInput(draft: WorkbenchThreadDraft | null): WorkbenchComposerInputDraft {
  return {
    text: draft?.prompt ?? "",
    attachments: draft?.attachments.flatMap((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return [];
      const candidate = attachment as { id?: string; url?: string };
      return typeof candidate.id === "string" && typeof candidate.url === "string"
        ? [{ id: candidate.id, url: candidate.url }] : [];
    }) ?? [],
    updatedAt: draft?.updatedAt ?? 0,
  };
}

export async function saveComposerDraft(
  state: WorkbenchClientStateController,
  target: ComposerDraftTarget,
  update: (draft: WorkbenchComposerInputDraft) => WorkbenchComposerInputDraft,
  options: { reason: "autosave" | "submission"; detached: boolean },
): Promise<WorkbenchComposerInputDraft | null> {
  if (target.kind === "thread") {
    const { daemonRegistrationId, projectId, threadId } = target;
    const identity = { kind: "composerDraft" as const, daemonRegistrationId, projectId, threadId };
    const current = state.records("composerDraft").find((record) => (
      record.daemonRegistrationId === daemonRegistrationId && record.projectId === projectId && record.threadId === threadId
    ))?.value ?? sidebarDraftToInput(null);
    const draft = { ...update(current), updatedAt: Date.now() };
    if (draft.text.trim() || draft.attachments.length) await state.put({ ...identity, value: draft });
    else await state.delete(identity);
    return draft;
  }
  const existing = target.owner.read(target.projectId, target.draftId);
  const input = { ...update(sidebarDraftToInput(existing)), updatedAt: Date.now() };
  if (target.isNew && !existing && options.reason === "autosave" && countDraftPromptTokens(input.text) < 3) return null;
  const draftId = target.draftId;
  const baseline = existing ?? target.owner.create(target.projectId, draftId);
  const draft: WorkbenchThreadDraft = {
    ...baseline,
    draftId,
    projectId: target.projectId,
    prompt: input.text,
    attachments: input.attachments.map(({ id, url }) => ({ id, url })),
    clientUpdatedAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
  await target.owner.write(draft, target.folderId);
  if (target.isNew && !existing && !options.detached) target.owner.materialize(draft);
  return input;
}

export async function clearComposerDraft(state: WorkbenchClientStateController, target: ComposerDraftTarget) {
  if (target.kind === "sidebar") return await target.owner.remove(target.projectId, target.draftId);
  const { daemonRegistrationId, projectId, threadId } = target;
  await state.delete({ kind: "composerDraft", daemonRegistrationId, projectId, threadId });
}

export async function saveQuestionnaireDraft(
  state: WorkbenchClientStateController,
  identity: ClientDraftIdentity & { requestKey: string },
  update: (draft: WorkbenchQuestionnaireDraft) => WorkbenchQuestionnaireDraft,
): Promise<WorkbenchQuestionnaireDraft> {
  const current = state.records("questionnaireDraft").find((record) => (
    record.daemonRegistrationId === identity.daemonRegistrationId && record.projectId === identity.projectId
    && record.threadId === identity.threadId && record.requestKey === identity.requestKey
  ))?.value ?? { attachments: [], customValues: {}, selectedValues: {}, updatedAt: 0 };
  const draft = { ...update(current), updatedAt: Date.now() };
  const hasContent = draft.attachments.length
    || Object.values(draft.customValues).some((value) => value.trim())
    || Object.values(draft.selectedValues).some((values) => values.some((value) => value.trim()));
  if (hasContent) await state.put({ kind: "questionnaireDraft", ...identity, value: draft });
  else await clearQuestionnaireDraft(state, identity);
  return draft;
}

export async function clearQuestionnaireDraft(
  state: WorkbenchClientStateController,
  identity: ClientDraftIdentity & { requestKey: string },
) {
  await state.delete({ kind: "questionnaireDraft", ...identity });
}
