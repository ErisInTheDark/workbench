/*
 * Exports:
 * - WorkbenchProviderMessageAdmission: one provider-chosen message outcome published after acceptance.
 * - WorkbenchProviderHiddenTurn: a Workbench-started hidden turn and its in-lane supersession check.
 * - WorkbenchProviderNativeLocations: pending native session moves after project merges, and their settlement.
 * - WorkbenchProviderHandleOptions: post-admission hooks, agent-message holds, instruction selection, native relocation and shared message admission policy.
 * - default WorkbenchProviderHandle: forward operations through the current definition lease, move a merged thread's native session
 *   before its next turn or compaction, supply thread instruction selections, admit compaction-queue deliveries inside their
 *   compaction's admission, hold agent messages for the user instead of compacting, and wake waits after accepted steers.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import providerRegistrations, { type WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchThreadMessage } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchThreadAdmissionTicket } from "../thread/WorkbenchThreadAdmissionController";
import type WorkbenchThreadAutoCompactController from "../turn/WorkbenchThreadAutoCompactController";
import type { AutoCompactRunOptions } from "../turn/WorkbenchThreadAutoCompactController";
import type WorkbenchThreadInstructionSelectionController from "../thread/WorkbenchThreadInstructionSelectionController";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchAgentMessageResult } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchMessageContext, WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

export interface WorkbenchProviderMessageAdmission {
  firstMessagePreview?: string;
  harness: WorkbenchProviderKey;
  kind: "started" | "steered";
  threadId: string;
  turnId: string;
}

export interface WorkbenchProviderHiddenTurn {
  threadId: string;
  clientMessageId: string;
  input: WorkbenchUserInput[];
  /** Runs inside the thread's admission lane, after every earlier admission; false skips the turn. */
  isCurrent(threads: Pick<WorkbenchProvider["threads"], "latestTurn" | "isTurnLive">): Promise<boolean>;
}

/** Native sessions a project merge left behind: where one must move, and recording that it did. */
export interface WorkbenchProviderNativeLocations {
  pending(threadId: string): string | null;
  settle(threadId: string, location: string): Promise<void>;
}

export interface WorkbenchProviderHandleOptions {
  interruptSteerWaits: (threadId: string, senderThreadId?: string) => void;
  nativeLocations?: WorkbenchProviderNativeLocations;
  instructionSelection?: Pick<WorkbenchThreadInstructionSelectionController, "resolve" | "activateSkills" | "record">;
  messageAdmission?: WorkbenchThreadAutoCompactController["run"];
  /** An agent message steered a live turn; its model sees it only at a later input boundary. */
  onAgentMessageAdmitted?: (threadId: string, message: WorkbenchAgentMessage) => Promise<void> | void;
  /** Inside the thread's admission: keep a held agent message for its user's next running turn. */
  holdAgentMessage?: (threadId: string, message: WorkbenchAgentMessage) => Promise<void>;
  onMessageAdmitted?: (admission: WorkbenchProviderMessageAdmission) => Promise<void> | void;
}

export default class WorkbenchProviderHandle implements WorkbenchProvider {
  constructor(
    private readonly key: WorkbenchProviderKey,
    private readonly run: WorkbenchProviderOperation,
    private readonly options: WorkbenchProviderHandleOptions,
  ) {}

  private admitted<T extends { kind: "started" | "steered" }>(threadId: string, result: T, senderThreadId?: string): T {
    if (result.kind === "steered") this.options.interruptSteerWaits(threadId, senderThreadId);
    return result;
  }

  private admitMessage<T>(
    threadId: string,
    provider: WorkbenchProvider,
    admit: () => Promise<T>,
    options?: AutoCompactRunOptions<T>,
  ): Promise<T> {
    const relocated = async () => {
      await this.relocatePending(threadId, provider);
      return await admit();
    };
    return this.options.messageAdmission ? this.options.messageAdmission(threadId, provider, relocated, options) : relocated();
  }

  /** A merge moved this thread's folder: its native session follows before the turn that would run there. */
  private async relocatePending(threadId: string, provider: WorkbenchProvider) {
    const location = this.options.nativeLocations?.pending(threadId);
    if (!location) return;
    const native = await provider.threads.relocate(threadId, location);
    await this.options.nativeLocations!.settle(threadId, native);
  }

  /**
   * Inside the admission lane, so a selection recorded by an earlier message is the one this message sees. Named skills
   * activate before the provider admits, so the message's own input boundary delivers their bodies; agent messages pass no input.
   */
  private async withSelection<T>(
    threadId: string, context: WorkbenchMessageContext | undefined,
    admit: (context: WorkbenchMessageContext | undefined) => Promise<T>,
    input?: readonly WorkbenchUserInput[],
  ) {
    const selection = this.options.instructionSelection;
    if (!selection) return await admit(context);
    const id = WorkbenchThreadIdSchema.parse(threadId);
    const resolved = await selection.resolve(id, context, input);
    await selection.activateSkills(id, resolved.activatedSkillPaths ?? []);
    const result = await admit(resolved);
    await selection.record(id, context);
    return result;
  }

  private publishMessageAdmission(
    threadId: string,
    admission: { kind: "started" | "steered"; turnId: string },
    firstMessagePreview?: string,
  ) {
    return this.options.onMessageAdmitted?.({
      harness: this.key,
      kind: admission.kind,
      threadId,
      turnId: admission.turnId,
      ...(firstMessagePreview ? { firstMessagePreview } : {}),
    });
  }

  private async publishAcceptedUserMessage<
    Result extends ({ kind: "started"; turn: { id: string }; warning?: string } | { kind: "steered"; turnId: string; warning?: string }),
  >(input: Parameters<WorkbenchProvider["threads"]["submit"]>[0], result: Result): Promise<Result> {
    const firstMessagePreview = input.intent === "newTurn"
      ? input.input.flatMap(part => part.type === "text" && part.text.trim() ? [part.text] : []).at(0)
      : undefined;
    try {
      await this.publishMessageAdmission(input.threadId, {
        kind: result.kind,
        turnId: result.kind === "started" ? result.turn.id : result.turnId,
      }, firstMessagePreview);
      return result;
    } catch {
      const warning = "Your message was accepted, but Workbench could not update its thread state. Do not resend it.";
      console.warn(`[thread-state] ${warning}`);
      return {
        ...result,
        warning: [result.warning?.slice(0, 500), warning].filter(Boolean).join(" "),
      };
    }
  }

  readonly context: NonNullable<WorkbenchProvider["context"]> = {
    inject: (input, signal) => this.run(providerRegistrations[this.key], provider => (
      provider.context?.inject(input, signal) ?? Promise.resolve("unsupported" as const)
    ), `${this.key}: context.inject`),
  };

  readonly configuration: WorkbenchProvider["configuration"] & {
    sandboxNetwork: NonNullable<WorkbenchProvider["configuration"]["sandboxNetwork"]>;
  } = {
    sandboxNetwork: {
      read: projectId => this.run(providerRegistrations[this.key], provider => (
        provider.configuration.sandboxNetwork?.read(projectId) ?? null
      ), `${this.key}: configuration.sandboxNetwork.read`),
      update: input => this.run(providerRegistrations[this.key], provider => {
        if (!provider.configuration.sandboxNetwork) throw new Error(`Provider ${this.key} does not support sandbox network settings.`);
        return provider.configuration.sandboxNetwork.update(input);
      }, `${this.key}: configuration.sandboxNetwork.update`),
    },
    modelContext: {
      read: () => this.run(
        providerRegistrations[this.key],
        (provider) => provider.configuration.modelContext.read(),
        `${this.key}: configuration.modelContext.read`,
      ),
    },
    models: {
      read: () => this.run(providerRegistrations[this.key], provider => provider.configuration.models.read(), `${this.key}: configuration.models.read`),
    },
    guidance: {
      contains: sections => this.run(providerRegistrations[this.key], provider => provider.configuration.guidance.contains(sections), `${this.key}: configuration.guidance.contains`),
    },
  };

  readonly threads: WorkbenchProvider["threads"] = {
    contextRollover: {
      requestDirective: input => this.run(providerRegistrations[this.key], provider => {
        if (!provider.threads.contextRollover) throw new Error(`Provider ${this.key} does not support context rollover.`);
        return provider.threads.contextRollover.requestDirective(input);
      }, `${this.key}: threads.contextRollover.requestDirective`),
      replace: input => this.run(providerRegistrations[this.key], provider => {
        if (!provider.threads.contextRollover) throw new Error(`Provider ${this.key} does not support context rollover.`);
        return provider.threads.contextRollover.replace(input);
      }, `${this.key}: threads.contextRollover.replace`),
    },
    reconcile: (input, signal) => this.run(providerRegistrations[this.key], provider => {
      if (!provider.threads.reconcile) throw new Error("Provider reconciliation is unavailable until its bridge is reloaded.");
      return provider.threads.reconcile(input, signal);
    }, `${this.key}: threads.reconcile`),
    history: {
      materialize: (threadId, turnId, signal) => this.run(providerRegistrations[this.key], provider => provider.threads.history.materialize(threadId, turnId, signal), `${this.key}: threads.history.materialize`),
    },
    create: input => this.run(providerRegistrations[this.key], provider => provider.threads.create(input), `${this.key}: threads.create`),
    list: input => this.run(providerRegistrations[this.key], provider => provider.threads.list(input), `${this.key}: threads.list`),
    read: (threadId, options) => this.run(providerRegistrations[this.key], provider => provider.threads.read(threadId, options), `${this.key}: threads.read`),
    readLatest: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.readLatest(threadId), `${this.key}: threads.readLatest`),
    latestTurn: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.latestTurn(threadId), `${this.key}: threads.latestTurn`),
    admitTurn: (threadId, turnReference) => this.run(providerRegistrations[this.key], provider => provider.threads.admitTurn(threadId, turnReference), `${this.key}: threads.admitTurn`),
    submit: input => this.submitUserMessage(input, { skipAutoCompact: input.skipAutoCompact, expectAutoCompact: input.expectAutoCompact }),
    messageAgent: async ({ holdForUser, ...input }) => {
      const hold = holdForUser && this.options.holdAgentMessage;
      const result: WorkbenchAgentMessageResult = await this.run(providerRegistrations[this.key], provider => this.admitMessage<WorkbenchAgentMessageResult>(
        input.threadId, provider,
        () => this.withSelection(input.threadId, input.context, context => provider.threads.messageAgent({ ...input, ...(context ? { context } : {}) })),
        hold ? { hold: async () => { await hold(input.threadId, input.message); return { kind: "held" }; } } : undefined,
      ), `${this.key}: threads.messageAgent`);
      if (result.kind === "held") return result;
      // A message that starts a turn is that turn's prompt, so the model already has it.
      if (result.kind === "steered") await this.options.onAgentMessageAdmitted?.(input.threadId, input.message);
      const admitted = this.admitted(input.threadId, result, input.message.senderThreadId);
      await this.publishMessageAdmission(input.threadId, admitted);
      return admitted;
    },
    rename: (threadId, title) => this.run(providerRegistrations[this.key], provider => provider.threads.rename(threadId, title), `${this.key}: threads.rename`),
    compact: (threadId, options) => this.run(providerRegistrations[this.key], async provider => {
      await this.relocatePending(threadId, provider);
      return await provider.threads.compact(threadId, options);
    }, `${this.key}: threads.compact`),
    relocate: (threadId, location) => this.run(providerRegistrations[this.key], provider => provider.threads.relocate(threadId, location), `${this.key}: threads.relocate`),
    delete: threadId => this.run(providerRegistrations[this.key], provider => {
      if (!provider.threads.delete) throw new Error(`Provider ${this.key} does not support deleting its threads.`);
      return provider.threads.delete(threadId);
    }, `${this.key}: threads.delete`),
    interrupt: threadId => this.run(providerRegistrations[this.key], provider => provider.threads.interrupt(threadId), `${this.key}: threads.interrupt`),
    isTurnLive: (threadId, turnId) => this.run(providerRegistrations[this.key], provider => provider.threads.isTurnLive(threadId, turnId), `${this.key}: threads.isTurnLive`),
    materialize: (threadId, turnIds, signal) => this.run(providerRegistrations[this.key], provider => provider.threads.materialize(threadId, turnIds, signal), `${this.key}: threads.materialize`),
  };

  /** Admit a compaction queue's merged delivery inside the admission its compaction already holds. */
  submitWithinAdmission(input: WorkbenchThreadMessage, admission: WorkbenchThreadAdmissionTicket) {
    return this.submitUserMessage(input, { skipAutoCompact: true, admission });
  }

  private async submitUserMessage(input: WorkbenchThreadMessage, options: Omit<AutoCompactRunOptions<never>, "hold">) {
    const { skipAutoCompact: _policy, expectAutoCompact: _expected, ...providerInput } = input;
    const result = this.admitted(input.threadId, await this.run(providerRegistrations[this.key], provider => (
      this.admitMessage(input.threadId, provider, () => this.withSelection(input.threadId, input.context, context => (
        provider.threads.submit({ ...providerInput, ...(context ? { context } : {}) })
      ), providerInput.input), options)
    ), `${this.key}: threads.submit`));
    return await this.publishAcceptedUserMessage(input, result);
  }

  /** Start a Workbench-owned hidden turn with the thread's selection, unless newer work superseded it in the lane. */
  async admitHiddenTurn(turn: WorkbenchProviderHiddenTurn): Promise<"started" | "superseded"> {
    const result = await this.run(providerRegistrations[this.key], provider => this.admitMessage(turn.threadId, provider, async () => {
      if (!await turn.isCurrent(provider.threads)) return null;
      return await this.withSelection(turn.threadId, undefined, context => provider.threads.submit({
        threadId: turn.threadId, clientMessageId: turn.clientMessageId, input: turn.input, intent: "newTurn",
        ...(context ? { context } : {}),
      }));
    }, { skipAutoCompact: true }), `${this.key}: threads.admitHiddenTurn`);
    if (!result) return "superseded";
    this.admitted(turn.threadId, result);
    try {
      await this.publishMessageAdmission(turn.threadId, {
        kind: result.kind, turnId: result.kind === "started" ? result.turn.id : result.turnId,
      });
    } catch (error) {
      // The provider already runs the turn; its own lifecycle observations still reach thread state.
      console.warn(`[thread-state] hidden turn admission was not published: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
    return "started";
  }

  private singleFileOperation<T>(operation: (owner: NonNullable<WorkbenchProvider["singleFile"]>) => Promise<T>) {
    return this.run(providerRegistrations[this.key], provider => {
      if (!provider.singleFile) throw new Error(`Provider ${this.key} does not support single-file editing.`);
      return operation(provider.singleFile);
    }, `${this.key}: singleFile`);
  }

  readonly singleFile: NonNullable<WorkbenchProvider["singleFile"]> = {
    prepare: () => this.singleFileOperation(owner => owner.prepare()),
    start: input => this.singleFileOperation(owner => owner.start(input)),
    input: (sessionId, input) => this.singleFileOperation(owner => owner.input(sessionId, input)),
    finish: sessionId => this.singleFileOperation(owner => owner.finish(sessionId)),
    cancel: sessionId => this.singleFileOperation(owner => owner.cancel(sessionId)),
  };

  readonly approvalReview: NonNullable<WorkbenchProvider["approvalReview"]> = {
    availability: () => this.run(providerRegistrations[this.key], provider => {
      if (!provider.approvalReview) throw new Error(`Provider ${this.key} cannot review approvals.`);
      return provider.approvalReview.availability();
    }, `${this.key}: approvalReview.availability`),
    review: (state, signal) => this.run(providerRegistrations[this.key], provider => {
      if (!provider.approvalReview) throw new Error(`Provider ${this.key} cannot review approvals.`);
      return provider.approvalReview.review(state, signal);
    }, `${this.key}: approvalReview.review`),
  };

  private interaction<T>(operation: (interactions: NonNullable<WorkbenchProvider["interactions"]>) => Promise<T>, label: string) {
    return this.run(providerRegistrations[this.key], provider => {
      if (!provider.interactions) throw new Error(`Provider ${this.key} does not support interactive requests.`);
      return operation(provider.interactions);
    }, `${this.key}: interactions.${label}`);
  }

  readonly interactions: NonNullable<WorkbenchProvider["interactions"]> = {
    interruptRetaining: (input, isCurrent) => this.interaction(owner => owner.interruptRetaining(input, isCurrent), "interruptRetaining"),
    pending: options => this.run(providerRegistrations[this.key], provider => provider.interactions?.pending(options) ?? Promise.resolve([]), `${this.key}: interactions.pending`),
    canDeliver: (threadId, requestKey) => this.interaction(owner => owner.canDeliver(threadId, requestKey), "canDeliver"),
    deliver: input => this.interaction(owner => owner.deliver(input), "deliver"),
    respond: input => this.interaction(owner => owner.respond(input), "respond"),
    supplement: input => this.interaction(owner => owner.supplement(input), "supplement"),
    record: entry => this.interaction(owner => owner.record(entry), "record"),
    deliverApproval: input => this.interaction(async owner => await owner.deliverApproval?.(input) ?? false, "deliverApproval"),
  };

  readonly usage: NonNullable<WorkbenchProvider["usage"]> = {
    hydrate: nativeThreadId => this.run(providerRegistrations[this.key], provider => {
      if (!provider.usage) throw new Error(`Provider ${this.key} does not hydrate usage.`);
      return provider.usage.hydrate(nativeThreadId);
    }, `${this.key}: usage.hydrate`),
  };

  /** Whether the current definition can hydrate usage; definitions can change across reloads. */
  hydratesUsage() {
    return this.run(providerRegistrations[this.key], provider => Boolean(provider.usage), `${this.key}: usage`);
  }

  private accountSignIn<T>(
    operation: (session: NonNullable<NonNullable<WorkbenchProvider["account"]>["signIn"]>) => Promise<T>,
    label: string,
  ) {
    return this.run(providerRegistrations[this.key], provider => {
      const session = provider.account?.signIn;
      if (!session) throw new Error(`Provider ${this.key} does not support account sign-in.`);
      return operation(session);
    }, `${this.key}: account.signIn.${label}`);
  }

  readonly account: Required<NonNullable<WorkbenchProvider["account"]>> = {
    signIn: {
      read: () => this.accountSignIn(session => session.read(), "read"),
      start: input => this.accountSignIn(session => session.start(input), "start"),
      submitCode: (attemptId, code) => this.accountSignIn(session => session.submitCode(attemptId, code), "submitCode"),
      wait: attemptId => this.accountSignIn(session => session.wait(attemptId), "wait"),
      cancel: attemptId => this.accountSignIn(session => session.cancel(attemptId), "cancel"),
      signOut: integrationId => this.accountSignIn(session => session.signOut(integrationId), "signOut"),
    },
    limits: {
      read: () => this.run(providerRegistrations[this.key], provider => {
        if (!provider.account) throw new Error(`Provider ${this.key} does not report account limits.`);
        return provider.account.limits.read();
      }, `${this.key}: account.limits.read`),
    },
  };

  private tool<T>(operation: (tools: NonNullable<WorkbenchProvider["tools"]>) => Promise<T>, label: string) {
    return this.run(providerRegistrations[this.key], provider => {
      if (!provider.tools) throw new Error(`Provider ${this.key} does not support managed tools.`);
      return operation(provider.tools);
    }, `${this.key}: tools.${label}`);
  }

  readonly tools: NonNullable<WorkbenchProvider["tools"]> = {
    transcript: {
      start: (input, signal, context) => this.tool(tools => tools.transcript?.start(input, signal, context) ?? Promise.resolve(null), "transcript.start"),
      finish: (reference, result) => this.tool(tools => {
        if (!tools.transcript) throw new Error(`Provider ${this.key} no longer supports admitted tool capture.`);
        return tools.transcript.finish(reference, result);
      }, "transcript.finish"),
    },
    prepareExecution: (request, signal) => this.tool(tools => {
      if (!tools.prepareExecution) throw new Error(`Provider ${this.key} does not support admitted execution.`);
      return tools.prepareExecution(request, signal);
    }, "prepareExecution"),
    patchClaims: (input, check, signal) => this.tool(tools => tools.patchClaims(input, check, signal), "patchClaims"),
    describe: () => this.tool(tools => tools.describe(), "describe"),
    caller: (metadata, signal, context) => this.tool(tools => tools.caller(metadata, signal, context), "caller"),
  };

  readonly browse: NonNullable<WorkbenchProvider["browse"]> = {
    screenshot: input => this.run(providerRegistrations[this.key], provider => {
      if (!provider.browse) throw new Error(`Provider ${this.key} does not support screenshot delivery.`);
      return provider.browse.screenshot(input);
    }, `${this.key}: browse.screenshot`),
  };
}
