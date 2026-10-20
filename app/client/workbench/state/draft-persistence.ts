/*
 * Exports:
 * - ClientDraftIdentity: project-qualified client-state address.
 * - ComposerDraftTarget: existing-thread or app-owned unsent destination.
 * - ComposerDraftTargetContext/resolveComposerDraftTarget: resolve a composer's draft destination at write time,
 *   including the new-thread route's materialise and dematerialise handoffs.
 * - presentationDraftToInput: project saved prompt, image attachments and references into composer input.
 * - readComposerDraft: the composer record saved at exactly one owner address.
 * - attachComposerDraftReference: append one reference to a composer draft without duplicating its identity.
 * - saveComposerDraft: merge edits and materialise eligible app drafts.
 * - clearComposerDraft: remove only the captured composer destination.
 * - saveQuestionnaireDraft: merge edits into the latest questionnaire record.
 * - clearQuestionnaireDraft: remove only the captured questionnaire record.
 */
import type {
  ThreadPayload, WorkbenchComposerInputDraft, WorkbenchComposerProfileTargetSelection, WorkbenchLogicalThreadRow,
  WorkbenchQuestionnaireDraft,
} from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { DraftIdSchema, ProjectIdSchema, ThreadReferenceSchema, type LogicalProjectId } from "workbench-shared/workbench/identity";
import {
  countDraftPromptTokens, hasWorkbenchThreadDraftContent, type WorkbenchThreadRouteTarget,
} from "workbench-shared/workbench/thread/thread-state";
import { createLogicalThreadRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { projectLogicalThreadDisplayOrder } from "workbench-shared/workbench/project/workbench-project-projection";
import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import type WorkbenchClientStateController from "./WorkbenchClientStateController";
import type WorkbenchComposerProfileController from "./WorkbenchComposerProfileController";
import type { WorkbenchClientStateSnapshot } from "./WorkbenchClientStateController";
import type WorkbenchPresentationClient from "./WorkbenchPresentationClient";
import type { DraftId, ProjectId, ThreadReference, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import { composerReferenceKey } from "workbench-shared/workbench/thread/composer-reference";

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
    /** The settled profile selection to save beside the draft; waits for the slot's saved selection first. */
    selection: () => Promise<WorkbenchComposerProfileTargetSelection>;
    owner: WorkbenchPresentationClient;
    placement?: Parameters<WorkbenchPresentationClient["putDraft"]>[1];
    materialize: () => void;
    dematerialize: () => void;
  };

/** What a composer draft destination is resolved from; every reader runs when the draft is written, not when rendered. */
export interface ComposerDraftTargetContext {
  threadDraftIdentityFor(threadId: string): ClientDraftIdentity | null;
  draftLocationFor(draftId: DraftId): ProjectLocationReference | null;
  presentation: WorkbenchPresentationClient | null;
  listingRows(): readonly WorkbenchLogicalThreadRow[];
  currentThread(): ThreadPayload | null;
  route(): WorkbenchRoute;
  navigate(route: WorkbenchRoute): void;
  profilesFor(daemonId: string): WorkbenchComposerProfileController | null;
}

export function resolveComposerDraftTarget(
  context: ComposerDraftTargetContext,
  projectId: string,
  threadId: string,
  originTarget?: WorkbenchThreadRouteTarget,
): ComposerDraftTarget {
  if (!projectId) throw new Error("The composer draft has no project identity.");
  const ownerProjectId = ProjectIdSchema.parse(projectId);
  if (originTarget?.kind !== "new" && originTarget?.kind !== "draft") {
    const ownerIdentity = context.threadDraftIdentityFor(threadId);
    if (!ownerIdentity) throw new Error("The thread daemon is not registered in app state.");
    return { kind: "thread", daemonRegistrationId: ownerIdentity.daemonRegistrationId,
      projectId: ownerIdentity.projectId, threadId: ThreadReferenceSchema.parse(threadId) };
  }
  const draftId = originTarget.kind === "draft" ? originTarget.draftId : DraftIdSchema.parse(threadId);
  const owner = context.presentation;
  if (!owner) throw new Error("The new-thread draft owner is unavailable.");
  const isNew = originTarget.kind === "new";
  const route = context.route();
  const location = context.draftLocationFor(draftId) ?? route.logical?.location;
  if (!location) throw new Error("The selected draft location is unavailable.");
  const logicalProjectId = route.logical?.threadOwnerProjectId
    ?? owner.snapshot().data?.locations.find(item => item.target.daemonId === location.daemonId
      && item.target.projectId === location.projectId)?.logicalProjectId;
  if (!logicalProjectId) throw new Error("This folder is waiting for its app project identity. Draft text remains local.");
  let placement: Extract<ComposerDraftTarget, { kind: "presentation" }>["placement"];
  if (originTarget.kind === "new" && originTarget.folderId && !owner.draft(draftId)) {
    const presentation = owner.snapshot().data;
    const folder = presentation && projectLogicalThreadDisplayOrder(logicalProjectId, context.listingRows(), presentation)
      .folders?.find(item => item.folderId === originTarget.folderId);
    if (!folder || folder.section === "settled") throw new Error("The draft folder is unavailable. Draft text remains local.");
    placement = { folderId: folder.folderId, priority: folder.section };
  }
  return {
    kind: "presentation", draftId, isNew, logicalProjectId, location, owner, placement,
    selection: async () => {
      const profiles = context.profilesFor(location.daemonId);
      if (!profiles) throw new Error("Composer profiles are unavailable. Draft text remains local.");
      const thread = context.currentThread();
      const harness = thread?.harness ?? defaultProviderKey;
      const slot = isNew
        ? { kind: "new-thread" as const, projectId: ownerProjectId }
        : { kind: "draft" as const, projectId: ownerProjectId, draftId, harness };
      await profiles.waitForSelection(slot);
      return profiles.getDraftSelection(slot, {
        agentPath: thread?.agentPath ?? null, agentSource: null, harness, model: thread?.model ?? "",
        reasoningEffort: thread?.reasoningEffort ?? null,
        serviceTier: thread?.serviceTier === "fast" ? "fast" : null,
        contextWindowTokens: thread?.contextWindowTokens ?? null,
      });
    },
    materialize: () => {
      const current = context.route();
      if (current.view !== "thread" || current.threadTarget?.kind !== "new" || !current.logical
        || (current.logical.threadOwnerProjectId
          ? current.logical.threadOwnerProjectId !== logicalProjectId
          : current.logical.location?.daemonId !== location.daemonId
            || current.logical.location.projectId !== location.projectId)
        || context.currentThread()?.id !== draftId) return;
      context.navigate(createLogicalThreadRoute(current.logical.threadOwnerProjectId
        ? current.logical.projectId : logicalProjectId, logicalProjectId, null, { draftId, kind: "draft" }));
    },
    dematerialize: () => {
      const current = context.route();
      if (current.view !== "thread" || current.threadTarget?.kind !== "draft"
        || current.threadTarget.draftId !== draftId || !current.logical
        || current.logical.threadOwnerProjectId !== logicalProjectId) return;
      context.navigate(createLogicalThreadRoute(current.logical.projectId,
        logicalProjectId, current.logical.location ?? location, { kind: "new" }));
    },
  };
}

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

export function readComposerDraft(
  records: WorkbenchClientStateSnapshot["records"],
  owner: ClientDraftIdentity | null,
): WorkbenchComposerInputDraft | null {
  const record = owner && records.find(item => item.kind === "composerDraft"
    && item.daemonRegistrationId === owner.daemonRegistrationId && item.projectId === owner.projectId
    && item.threadId === owner.threadId);
  return record?.kind === "composerDraft" ? { ...record.value, references: record.value.references ?? [] } : null;
}

export function attachComposerDraftReference(
  draft: WorkbenchComposerInputDraft,
  reference: PresentationDraftReference,
): WorkbenchComposerInputDraft {
  const references = draft.references ?? [];
  const key = composerReferenceKey(reference);
  return references.some(item => composerReferenceKey(item) === key)
    ? draft
    : { ...draft, references: [...references, reference] };
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
    const stored = state.records("composerDraft").find((record) => (
      record.daemonRegistrationId === daemonRegistrationId && record.projectId === projectId && record.threadId === threadId
    ))?.value ?? { text: "", attachments: [], updatedAt: 0 };
    const current = { ...stored, references: stored.references ?? [] };
    const draft = { ...update(current), updatedAt: Date.now() };
    if (!hasWorkbenchThreadDraftContent({
      attachments: draft.attachments,
      prompt: draft.text,
      references: draft.references,
    })) {
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
    const selection = await target.selection();
    await target.owner.putDraft({
      id: target.draftId,
      logicalProjectId: existing?.logicalProjectId ?? target.logicalProjectId,
      target: existing?.target ?? target.location,
      prompt: input.text,
      references,
      selection,
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
