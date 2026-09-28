/*
 * Exports:
 * - WorkbenchLaunchedDraft: the accepted thread identity a draft launch applied.
 * - default WorkbenchWorkspaceDrafts: validate and launch saved app drafts through their durable original owner.
 */
import { randomUUID } from "node:crypto";
import type { WorkbenchHarness, WorkbenchSendThreadMessageOptions } from "workbench-shared/types";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { areWorkbenchAgentPathsEqual } from "workbench-shared/workbench/agent-paths";
import { resolveLinkedProfileSelection } from "workbench-shared/workbench/thread/thread-profile";
import { WorkbenchThreadLaunchRequestSchema, type WorkbenchThreadLaunchState } from "workbench-shared/workbench/thread/thread-launch";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type { DaemonId } from "workbench-shared/workbench/identity";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";

export interface WorkbenchLaunchedDraft {
  threadId: string;
  harness: WorkbenchHarness;
}

export default class WorkbenchWorkspaceDrafts {
  private readonly launches = new Map<string, Promise<WorkbenchLaunchedDraft>>();
  private closed = false;

  constructor(private readonly options: {
    presentation: WorkbenchPresentationController;
    sources: { get(id: DaemonId): Pick<WorkbenchDaemonSource, "available" | "daemon" | "retain"> | null | undefined };
    origin(): string | null;
    warn(message: string): void;
  }) {}

  launch(draftId: string, expectedRevision: number, options: WorkbenchSendThreadMessageOptions = {}) {
    if (this.closed) return Promise.reject(new Error("Draft launch service is closing."));
    const existing = this.launches.get(draftId);
    if (existing) return existing;
    const operation = this.performLaunch(draftId, expectedRevision, options);
    this.launches.set(draftId, operation);
    void operation.then(
      () => { if (this.launches.get(draftId) === operation) this.launches.delete(draftId); },
      error => {
        if (this.launches.get(draftId) === operation) this.launches.delete(draftId);
        this.options.warn(`Draft launch failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      },
    );
    return operation;
  }

  async dispose() {
    this.closed = true;
    // An accepted operation belongs to this service, not the tab which submitted it.
    await Promise.allSettled(this.launches.values());
  }

  private async performLaunch(draftId: string, expectedRevision: number, options: WorkbenchSendThreadMessageOptions): Promise<WorkbenchLaunchedDraft> {
    const presentation = this.options.presentation;
    const accepted = presentation.readAcceptedLaunch(draftId);
    if (accepted) return accepted;
    let draft = presentation.read().drafts.find(item => item.id === draftId);
    if (!draft) throw new Error("The saved draft is unavailable.");
    if (draft.phase !== "unsent" && draft.phase !== "submitting") throw new Error("This draft cannot start another thread.");
    if (draft.revision !== expectedRevision && draft.phase !== "submitting") {
      throw new Error("The saved draft changed before launch.");
    }
    const source = this.options.sources.get(draft.target.daemonId);
    if (!source?.available) throw new WorkbenchRpcRequestInterruptedError("The draft's original daemon is unavailable; launch was not sent.", false);
    const release = source.retain();
    try {
      const daemon = source.daemon;
      const target = draft.target;
      const registered = presentation.read().locations.find(item =>
        item.target.daemonId === target.daemonId && item.target.projectId === target.projectId);
      if (registered?.logicalProjectId !== draft.logicalProjectId) {
        throw new Error("The draft folder belongs to another project identity.");
      }
      // A linked draft resolves its stored profile's current definition at launch, exactly as its
      // composer previews it. Saved settings survive as Custom only when the definition is gone.
      let profile = draft.selection;
      if (draft.phase === "unsent") {
        if (profile.kind === "profile") {
          const resolved = resolveLinkedProfileSelection((await daemon.profiles.read()).profiles, profile);
          if (!resolved) throw new Error("This draft has no available composer settings.");
          profile = resolved;
        }
        const settings = profile.settings;
        const models = (await daemon.models.list(settings.harness)).data.filter(model => model.policyState !== "disabled");
        if (!models.length || settings.model && !models.some(model => model.id === settings.model)) {
          throw new Error("The destination daemon does not support this draft's model.");
        }
        if (settings.agentPath) {
          const agents = (await daemon.agents.list({ projectId: target.projectId })).data;
          if (!agents.some(agent => areWorkbenchAgentPathsEqual(agent.path, settings.agentPath))) {
            throw new Error("The destination folder does not have this draft's selected agent.");
          }
        }
      }
      const firstInput: UserInput[] = draft.prompt.trim()
        ? [{ type: "text", text: draft.prompt, text_elements: [] }] : [];
      for (const attachment of draft.attachments) {
        const stored = presentation.readAttachment(draftId, attachment.id);
        if (!stored) throw new Error("The saved draft image is unavailable.");
        const bytes = Buffer.concat([...stored.chunks()].map(chunk => chunk.content));
        if (bytes.length !== stored.content_length) throw new Error("The saved draft image is incomplete.");
        firstInput.push({ type: "image", url: `data:${stored.media_type};base64,${bytes.toString("base64")}` });
      }
      const wasSubmitting = draft.phase === "submitting";
      const launchId = draft.launchId ?? randomUUID();
      const context = {
        workbenchOrigin: this.options.origin(), instructionScope: "full" as const,
        instructionInjections: options.instructionInjections, workflowIds: options.workflowIds ?? ["default"],
        activatedSkillPaths: options.activatedSkillPaths,
      };
      const request = WorkbenchThreadLaunchRequestSchema.parse({
        launchId, projectId: target.projectId, profile, firstInput,
        clientMessageId: `launch:${launchId}`, creationContext: context, messageContext: context,
        additionalWritableRoots: options.additionalWritableRoots,
      });
      if (!wasSubmitting) {
        presentation.mutate({ kind: "reserveLaunch", draftId, expectedRevision: draft.revision, launchId, selection: profile });
        draft = presentation.read().drafts.find(item => item.id === draftId);
        if (draft?.launchId !== launchId) throw new Error("The launch reservation was not retained.");
      }
      let state: WorkbenchThreadLaunchState | null = null;
      try {
        if (wasSubmitting) state = (await daemon.launches.read({ launchId })).state;
        if (!state || state.phase === "prepared" || state.phase === "created") state = await daemon.launches.create(request);
      } catch (error) {
        try { state = (await daemon.launches.read({ launchId })).state; }
        catch (reconcileError) {
          const uncertain = new WorkbenchRpcRequestInterruptedError(
            "The launch outcome is uncertain. Reconcile this saved draft on its original daemon.", true,
          );
          uncertain.cause = new AggregateError([error, reconcileError]);
          throw uncertain;
        }
        if (!state) throw new WorkbenchRpcRequestInterruptedError(
          "The launch is not recorded yet. Reconcile this same saved draft on its original daemon.", true,
        );
      }
      if (state.phase !== "accepted") {
        state = (await daemon.launches.read({ launchId })).state ?? state;
        if (state.phase === "failed") throw new Error(state.reason);
        if (state.phase !== "accepted") throw new WorkbenchRpcRequestInterruptedError(
          "The launch is not confirmed. Reconcile this saved draft; do not create another thread.", true,
        );
      }
      presentation.mutate({ kind: "completeLaunch", draftId, launchId, threadId: state.threadId });
      return { threadId: state.threadId, harness: profile.settings.harness };
    } finally { release(); }
  }
}
