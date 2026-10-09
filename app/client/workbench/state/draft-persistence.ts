/*
 * Exports:
 * - ClientDraftIdentity: project-qualified client-state address.
 * - ComposerDraftTarget: existing-thread or app-owned unsent destination.
 * - presentationDraftToInput: project saved prompt, image attachments and references into composer input.
 * - projectComposerDrafts: select only composer records matching each UUID's registered owner.
 * - saveComposerDraft: merge edits and materialise eligible app drafts.
 * - clearComposerDraft: remove only the captured composer destination.
 * - saveQuestionnaireDraft: merge edits into the latest questionnaire record.
 * - clearQuestionnaireDraft: remove only the captured questionnaire record.
 */
import type { WorkbenchComposerInputDraft, WorkbenchComposerProfileTargetSelection, WorkbenchQuestionnaireDraft } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import { countDraftPromptTokens, hasWorkbenchThreadDraftContent } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchClientStateController from "./WorkbenchClientStateController";
import type { WorkbenchClientStateSnapshot } from "./WorkbenchClientStateController";
import type WorkbenchPresentationClient from "./WorkbenchPresentationClient";
import type { DraftId, ProjectId, ThreadReference, WorkbenchThreadId } from "workbench-shared/workbench/identity";

export interface ClientDraftIdentity {
  daemonRegistrationId: string;
  projectId: ProjectId;
  threadId: ThreadReference | WorkbenchThreadId;
}

type QuestionnaireDraftIdentity = ClientDraftIdentity & { requestKey: string };
type QuestionnaireDraftIdentityResolver = () => QuestionnaireDraftIdentity | null;

export type ComposerDraftTarget =
  | (ClientDraftIdentity & { kind: "thread" })
  | {
    kind: "presentation"; draftId: DraftId; isNew: boolean;
    logicalProjectId: LogicalProjectId; location: ProjectLocationReference;
    selection: () => WorkbenchComposerProfileTargetSelection;
    owner: WorkbenchPresentationClient;
    placement?: Parameters<WorkbenchPresentationClient["putDraft"]>[1];
    materialize: () => void;
    dematerialize: () => void;
  };

export function presentationDraftToInput(owner: WorkbenchPresentationClient, id: string): WorkbenchComposerInputDraft | null {
  const draft = owner.draft(id);
  if (!draft || draft.phase !== "unsent") return null;
  return {
    text: draft.prompt,
    attachments: draft.attachments.map(item => ({ id: item.id, url: owner.attachmentUrl(draft.id, item.id) })),
    references: draft.references ?? [],
    updatedAt: draft.updatedAt,
  };
}

export function projectComposerDrafts(
  records: WorkbenchClientStateSnapshot["records"],
  identityFor: (threadId: string) => ClientDraftIdentity | null,
): Record<string, WorkbenchComposerInputDraft> {
  return Object.fromEntries(records.flatMap(record => {
    if (record.kind !== "composerDraft") return [];
    const owner = identityFor(record.threadId);
    return owner && owner.daemonRegistrationId === record.daemonRegistrationId
      && owner.projectId === record.projectId && owner.threadId === record.threadId
      ? [[record.threadId, record.value] as const] : [];
  }));
}

export async function saveComposerDraft(
  state: WorkbenchClientStateController,
  target: ComposerDraftTarget,
  update: (draft: WorkbenchComposerInputDraft) => WorkbenchComposerInputDraft,
  options: { reason: "autosave" | "submission" | "retarget"; detached: boolean },
): Promise<WorkbenchComposerInputDraft | null> {
  if (target.kind === "thread") {
    const { daemonRegistrationId, projectId, threadId } = target;
    const identity = { kind: "composerDraft" as const, daemonRegistrationId, projectId, threadId };
    const current = state.records("composerDraft").find((record) => (
      record.daemonRegistrationId === daemonRegistrationId && record.projectId === projectId && record.threadId === threadId
    ))?.value ?? { text: "", attachments: [], updatedAt: 0 };
    const draft = { ...update(current), updatedAt: Date.now() };
    if (!draft.text.trim() && !draft.attachments.length) {
      await state.delete(identity);
      return draft;
    }
    if (!state.supportsAttachmentUrls()) {
      await state.put({ ...identity, value: draft });
      return draft;
    }
    const savedIds = new Set(current.attachments.map(item => item.id));
    await state.put({
      ...identity,
      value: {
        ...draft,
        attachments: draft.attachments.filter(item => savedIds.has(item.id)),
      },
    });
    const uploadedUrls = new Map<string, string>();
    for (const attachment of draft.attachments) {
      if (savedIds.has(attachment.id)) continue;
      uploadedUrls.set(attachment.id,
        await state.uploadDraftAttachment(identity, attachment.id, attachment.url));
    }
    return {
      ...draft,
      attachments: draft.attachments.map(item => ({
        ...item, url: uploadedUrls.get(item.id) ?? item.url,
      })),
    };
  }
  else {
    const existing = target.owner.draft(target.draftId);
    const input = { ...update(presentationDraftToInput(target.owner, target.draftId)
      ?? { text: "", attachments: [], references: [], updatedAt: 0 }), updatedAt: Date.now() };
    const references = input.references ?? [];
    if (!hasWorkbenchThreadDraftContent({ attachments: input.attachments, prompt: input.text, references })) {
      if (existing) await target.owner.removeDraft(target.draftId);
      if (existing && !options.detached) target.dematerialize();
      return existing || options.reason !== "autosave" ? input : null;
    }
    // Attachments and references make a draft worth keeping on their own; bare text waits for a few words.
    if (target.isNew && !existing && options.reason === "autosave"
      && !input.attachments.length && !references.length && countDraftPromptTokens(input.text) < 3) return null;
    await target.owner.putDraft({
      id: target.draftId,
      logicalProjectId: existing?.logicalProjectId ?? target.logicalProjectId,
      target: existing?.target ?? target.location,
      prompt: input.text,
      references,
      selection: target.selection(),
      updatedAt: input.updatedAt,
    }, target.placement);
    for (const attachment of input.attachments) {
      if (target.owner.draft(target.draftId)?.attachments.some(item => item.id === attachment.id)) continue;
      await target.owner.uploadAttachment(target.draftId, attachment.id, attachment.url);
    }
    for (const attachment of target.owner.draft(target.draftId)?.attachments ?? []) {
      if (input.attachments.some(item => item.id === attachment.id)) continue;
      const revision = target.owner.draft(target.draftId)?.revision;
      if (revision !== undefined) await target.owner.mutate({
        kind: "deleteAttachment", draftId: target.draftId,
        attachmentId: attachment.id, expectedRevision: revision,
      });
    }
    if (target.isNew && !options.detached && options.reason !== "retarget") target.materialize();
    return { ...input, references, attachments: input.attachments.map(item => ({
      id: item.id, url: target.owner.attachmentUrl(target.draftId, item.id),
    })) };
  }
}

export async function clearComposerDraft(state: WorkbenchClientStateController, target: ComposerDraftTarget) {
  if (target.kind === "presentation") return await target.owner.removeDraft(target.draftId);
  const { daemonRegistrationId, projectId, threadId } = target;
  await state.delete({ kind: "composerDraft", daemonRegistrationId, projectId, threadId });
}

export async function saveQuestionnaireDraft(
  state: WorkbenchClientStateController,
  resolveIdentity: QuestionnaireDraftIdentityResolver,
  update: (draft: WorkbenchQuestionnaireDraft) => WorkbenchQuestionnaireDraft,
): Promise<WorkbenchQuestionnaireDraft> {
  const identity = resolveIdentity();
  if (!identity) throw new Error("The questionnaire draft owner is unavailable.");
  const current = state.records("questionnaireDraft").find((record) => (
    record.daemonRegistrationId === identity.daemonRegistrationId && record.projectId === identity.projectId
    && record.threadId === identity.threadId && record.requestKey === identity.requestKey
  ))?.value ?? { attachments: [], customValues: {}, selectedValues: {}, updatedAt: 0 };
  const draft = { ...update(current), updatedAt: Date.now() };
  const hasContent = draft.attachments.length
    || Object.values(draft.customValues).some((value) => value.trim())
    || Object.values(draft.selectedValues).some((values) => values.some((value) => value.trim()));
  if (!hasContent) {
    await clearQuestionnaireDraft(state, () => identity);
    return draft;
  }
  if (!state.supportsAttachmentUrls()) {
    await state.put({ kind: "questionnaireDraft", ...identity, value: draft });
    return draft;
  }
  const savedIds = new Set(current.attachments.map(item => item.id));
  await state.put({
    kind: "questionnaireDraft", ...identity,
    value: {
      ...draft,
      attachments: draft.attachments.filter(item => savedIds.has(item.id)),
    },
  });
  const uploadedUrls = new Map<string, string>();
  for (const attachment of draft.attachments) {
    if (savedIds.has(attachment.id)) continue;
    uploadedUrls.set(attachment.id, await state.uploadDraftAttachment(
      { kind: "questionnaireDraft", ...identity }, attachment.id, attachment.url));
  }
  return {
    ...draft,
    attachments: draft.attachments.map(item => ({
      ...item, url: uploadedUrls.get(item.id) ?? item.url,
    })),
  };
}

export async function clearQuestionnaireDraft(
  state: WorkbenchClientStateController,
  resolveIdentity: QuestionnaireDraftIdentityResolver,
) {
  const identity = resolveIdentity();
  if (!identity) throw new Error("The questionnaire draft owner is unavailable.");
  await state.delete({ kind: "questionnaireDraft", ...identity });
}
