/*
 * Exports:
 * - WorkbenchLaunchedDraft: the accepted thread identity a draft launch applied.
 * - default WorkbenchWorkspaceDrafts: validate and launch saved app drafts, led by their composer references, through their durable original owner;
 *   publish which reservations are in flight, and resolve any reservation no launch is running for (complete, release, or discard).
 */
import { randomUUID } from "node:crypto";
import type { WorkbenchHarness, WorkbenchSendThreadMessageOptions } from "workbench-shared/types";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { areWorkbenchAgentPathsEqual } from "workbench-shared/workbench/agent-paths";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { createComposerReferenceMessage } from "workbench-shared/workbench/thread/composer-reference";
import { readWorkbenchSkillActivationMismatch } from "workbench-shared/workbench/thread/thread-skill-mentions";
import { resolveLinkedProfileSelection } from "workbench-shared/workbench/thread/thread-profile";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
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
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private inFlightIds: ReadonlySet<string> = new Set();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(private readonly options: {
    presentation: WorkbenchPresentationController;
    sources: {
      get(id: DaemonId): Pick<WorkbenchDaemonSource, "available" | "daemon" | "retain"> | null | undefined;
      subscribe?(listener: () => void): () => void;
    };
    origin(): string | null;
    warn(message: string): void;
    canAdmit?(): boolean;
  }) {}

  /** Reservations this owner is launching right now; only these stand in for their thread. */
  inFlight = () => this.inFlightIds;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Reconcile reservations no launch is running for, now and whenever a daemon becomes reachable. */
  start() {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.options.sources.subscribe?.(() => this.reconcileOrphans()) ?? (() => {});
    this.reconcileOrphans();
  }

  launch(draftId: string, expectedRevision: number, options: WorkbenchSendThreadMessageOptions = {}) {
    if (this.closed) return Promise.reject(new Error("Draft launch service is closing."));
    if (this.options.canAdmit?.() === false) return Promise.reject(new Error("Draft launch service is reloading."));
    const existing = this.launches.get(draftId);
    if (existing) return existing;
    const operation = this.performLaunch(draftId, expectedRevision, options);
    this.launches.set(draftId, operation);
    this.publishInFlight();
    void operation.then(
      () => this.settle(draftId, operation),
      error => {
        this.settle(draftId, operation);
        this.options.warn(`Draft launch failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      },
    );
    return operation;
  }

  async dispose() {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    // An accepted operation belongs to this service, not the tab which submitted it.
    await Promise.allSettled([...this.launches.values(), ...this.reconciling.values()]);
  }

  async drain() {
    await Promise.allSettled([...this.launches.values(), ...this.reconciling.values()]);
  }

  private settle(draftId: string, operation: Promise<WorkbenchLaunchedDraft>) {
    if (this.launches.get(draftId) !== operation) return;
    this.launches.delete(draftId);
    this.publishInFlight();
  }

  private publishInFlight() {
    this.inFlightIds = new Set(this.launches.keys());
    for (const listener of this.listeners) listener();
  }

  /** A reservation without a running launch has lost its tie: resolve it from the daemon's launch record. */
  private reconcileOrphans() {
    if (this.closed || this.options.canAdmit?.() === false) return;
    for (const draft of this.options.presentation.read().drafts) {
      if (draft.phase !== "submitting" || !draft.launchId || this.launches.has(draft.id) || this.reconciling.has(draft.id)) continue;
      const source = this.options.sources.get(draft.target.daemonId);
      if (!source?.available) continue;
      const release = source.retain();
      const operation = this.resolveOrphan(draft.id, draft.launchId, source.daemon)
        .catch(error => this.options.warn(`Orphaned draft launch was not reconciled: ${
          error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`))
        .finally(() => { release(); this.reconciling.delete(draft.id); });
      this.reconciling.set(draft.id, operation);
    }
  }

  private async resolveOrphan(draftId: string, launchId: string, daemon: WorkbenchDaemonSource["daemon"]) {
    const state = (await daemon.launches.read({ launchId })).state;
    if (this.launches.has(draftId)) return;
    this.resolveEndedLaunch(draftId, launchId, state);
  }

  private endedLaunchError(draftId: string, launchId: string, state: WorkbenchThreadLaunchState | null, reason: string) {
    const outcome = this.resolveEndedLaunch(draftId, launchId, state);
    return new Error(outcome === "discarded"
      ? `${reason} Its message already lives in an existing thread or draft, so this draft was removed.`
      : `${reason} The draft is editable again.`);
  }

  /**
   * End a reservation whose launch is over: an accepted one completes; otherwise the draft is editable again, unless
   * its content already lives on in a thread the launch created or an identical draft, in which case it is discarded.
   */
  private resolveEndedLaunch(draftId: string, launchId: string, state: WorkbenchThreadLaunchState | null) {
    const presentation = this.options.presentation;
    const draft = presentation.read().drafts.find(item => item.id === draftId);
    if (draft?.phase !== "submitting" || draft.launchId !== launchId) return "superseded" as const;
    if (state?.phase === "accepted") {
      presentation.mutate({ kind: "completeLaunch", draftId, launchId, threadId: state.threadId });
      return "completed" as const;
    }
    const createdThread = state && "threadId" in state && state.threadId;
    const duplicated = presentation.read().drafts.some(other => other.id !== draftId && other.phase === "unsent"
      && other.target.daemonId === draft.target.daemonId && other.target.projectId === draft.target.projectId
      && other.prompt === draft.prompt && areDeeplyEqual(other.references ?? [], draft.references ?? [])
      && areDeeplyEqual(other.attachments.map(item => item.contentHash), draft.attachments.map(item => item.contentHash)));
    const discard = Boolean(createdThread || duplicated);
    presentation.mutate({ kind: "releaseLaunch", draftId, launchId, ...(discard ? { discard: true as const } : {}) });
    return discard ? "discarded" as const : "released" as const;
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
        if (!settings.model.trim()) throw new Error("The draft has no selected model yet.");
        const models = (await daemon.models.list(settings.harness)).data.filter(model => model.policyState !== "disabled");
        if (!models.some(model => matchesWorkbenchModelOption(model, settings.model))) {
          throw new Error("The destination daemon does not support this draft's model.");
        }
        if (settings.agentPath) {
          const agents = (await daemon.agents.list({ projectId: target.projectId })).data;
          if (!agents.some(agent => areWorkbenchAgentPathsEqual(agent.path, settings.agentPath))) {
            throw new Error("The destination folder does not have this draft's selected agent.");
          }
        }
      }
      const references = draft.references ?? [];
      const firstText = createComposerReferenceMessage(references, draft.prompt);
      const firstInput: UserInput[] = firstText ? [{ type: "text", text: firstText, text_elements: [] }] : [];
      const addressedFeedback = references.filter(reference => reference.kind === "feedback");
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
        ...(addressedFeedback.length ? { addressedFeedback } : {}),
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
        // A definite pre-reservation rejection the composer reconciles; nothing was launched, so the draft reopens for edits.
        if (readWorkbenchSkillActivationMismatch(error)) {
          presentation.mutate({ kind: "releaseLaunch", draftId, launchId });
          throw error;
        }
        try { state = (await daemon.launches.read({ launchId })).state; }
        catch (reconcileError) {
          // Only an unreadable outcome keeps the reservation; it resolves once its daemon is reachable again.
          const uncertain = new WorkbenchRpcRequestInterruptedError(
            "The launch outcome is uncertain until its daemon is reachable again.", true,
          );
          uncertain.cause = new AggregateError([error, reconcileError]);
          throw uncertain;
        }
        // The request may still reach the daemon, so an unrecorded launch keeps its reservation for a retry to resume.
        if (!state) throw new WorkbenchRpcRequestInterruptedError(
          "The launch is not recorded yet. Send this same draft again to resume it.", true,
        );
      }
      if (state.phase !== "accepted") {
        state = (await daemon.launches.read({ launchId })).state ?? state;
        if (state.phase !== "accepted") throw this.endedLaunchError(draftId, launchId, state,
          "reason" in state ? state.reason : "The launch did not finish.");
      }
      presentation.mutate({ kind: "completeLaunch", draftId, launchId, threadId: state.threadId });
      return { threadId: state.threadId, harness: profile.settings.harness };
    } finally { release(); }
  }
}
