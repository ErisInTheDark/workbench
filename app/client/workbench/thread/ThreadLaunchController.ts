/*
 * Exports:
 * - default ThreadLaunchController: reserve one app draft, dispatch once to its recorded daemon, and reconcile uncertain admission.
 */
import type { WorkbenchSendThreadMessageOptions } from "workbench-shared/types";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { WorkbenchThreadLaunchRequestSchema, type WorkbenchThreadLaunchState } from "workbench-shared/workbench/thread/thread-launch";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type WorkbenchPresentationClient from "../state/WorkbenchPresentationClient";

export default class ThreadLaunchController {
  constructor(private readonly owner: {
    presentation: WorkbenchPresentationClient;
    daemon: (location: ProjectLocationReference) => WorkbenchDaemonClient | null;
  }) {}

  async launch(draftId: string, input: UserInput[], options: WorkbenchSendThreadMessageOptions = {}) {
    let draft = this.owner.presentation.draft(draftId);
    if (!draft) throw new Error("The saved draft is unavailable.");
    if (draft.phase === "accepted" && draft.acceptedThreadId) return draft.acceptedThreadId;
    if (draft.phase !== "unsent" && draft.phase !== "submitting") {
      throw new Error("This draft cannot start another thread.");
    }
    const target = draft.target;
    const attachments = draft.attachments;
    const daemon = this.owner.daemon(target);
    if (!daemon) throw new Error("The draft's original daemon is unavailable.");
    const firstInput = await Promise.all(input.map(async (item): Promise<UserInput> => {
      if (item.type !== "image" || !attachments.some(attachment =>
        this.owner.presentation.attachmentUrl(draftId, attachment.id) === item.url)) return item;
      const response = await fetch(item.url);
      if (!response.ok) throw new Error("The saved draft image is unavailable.");
      const blob = await response.blob();
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("The draft image could not be read."));
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result) : reject(new Error("The draft image did not decode."));
        reader.readAsDataURL(blob);
      });
      return { ...item, url };
    }));
    const wasSubmitting = draft.phase === "submitting";
    const launchId = draft.launchId ?? crypto.randomUUID();
    const messageContext = {
      workbenchOrigin: typeof window === "undefined" ? null : window.location.origin,
      instructionScope: "full" as const,
      instructionInjections: options.instructionInjections,
      workflowIds: options.workflowIds ?? ["default"],
      activatedSkillPaths: options.activatedSkillPaths,
    };
    const request = WorkbenchThreadLaunchRequestSchema.parse({
      launchId,
      projectId: target.projectId,
      profile: draft.selection,
      firstInput,
      clientMessageId: `launch:${launchId}`,
      creationContext: messageContext,
      messageContext,
      additionalWritableRoots: options.additionalWritableRoots,
    });
    if (!wasSubmitting) {
      await this.owner.presentation.mutate({
        kind: "reserveLaunch", draftId: draft.id, expectedRevision: draft.revision, launchId,
      });
      draft = this.owner.presentation.draft(draftId);
      if (!draft || draft.launchId !== launchId) throw new Error("The launch reservation was not retained.");
    }
    let state: WorkbenchThreadLaunchState | null = null;
    try {
      if (wasSubmitting) state = (await daemon.launches.read({ launchId })).state;
      if (!state || state.phase === "prepared" || state.phase === "created") {
        state = await daemon.launches.create(request);
      }
    } catch (error) {
      try {
        state = (await daemon.launches.read({ launchId })).state;
      } catch (reconcileError) {
        throw new AggregateError([error, reconcileError],
          "The launch outcome is uncertain. Reconnect to its original daemon before trying again.");
      }
      if (!state) throw new Error("The launch was not recorded by its daemon. Retry this same saved draft.");
    }
    if (state.phase !== "accepted") {
      const latest = (await daemon.launches.read({ launchId })).state ?? state;
      if (latest.phase !== "accepted") {
        throw new Error(latest.phase === "failed" ? latest.reason
          : "The launch is not confirmed yet. Reconcile this saved draft on its original daemon; do not send a second thread.");
      }
      state = latest;
    }
    await this.owner.presentation.mutate({
      kind: "completeLaunch", draftId, launchId, threadId: state.threadId,
    });
    return state.threadId;
  }
}
