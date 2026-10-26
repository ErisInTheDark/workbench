/*
 * Exports:
 * - WorkbenchCoreTranscript: the transcript registration surface core owners use.
 * - default WorkbenchTurnRuntimeFeature: build turn admission, liveness, compaction, auto-compaction, context rollover, transcript reading and
 *   reconciliation, unfinished-turn continuation and orphaned-turn settlement, and own runtime fact fan-out (including live shell queues, output and yields)
 *   plus the `threadRuntime` registration.
 */
import { ProjectIdSchema, ThreadReferenceSchema, TurnReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import providerRegistrations, { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { WorkbenchHarnessSchema, type ThreadRuntime, type WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadSummaryFacts } from "workbench-shared/workbench/thread/thread-summary";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects, DaemonTranscriptRegistration } from "../daemon-runtime-objects";
import type WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import type { ReloadableNodeBuild } from "../runtime/ReloadableNode";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
import type { WorkbenchAgentMcpRequestRegistry } from "../agent/workbench-agent-mcp-request-registry";
import WorkbenchThreadAdmissionController from "../thread/WorkbenchThreadAdmissionController";
import WorkbenchThreadAutoCompactController from "../turn/WorkbenchThreadAutoCompactController";
import WorkbenchThreadCompactionController from "../turn/WorkbenchThreadCompactionController";
import WorkbenchThreadContextRolloverController from "../turn/WorkbenchThreadContextRolloverController";
import WorkbenchThreadTurnLiveness from "../turn/WorkbenchThreadTurnLiveness";
import WorkbenchTranscriptReader, { threadPayloadStatus } from "../transcript/WorkbenchTranscriptReader";
import WorkbenchTranscriptReconciliationController from "../transcript/WorkbenchTranscriptReconciliationController";
import WorkbenchTurnContinuationController from "../turn/WorkbenchTurnContinuationController";
import WorkbenchTurnSettlementController from "../turn/WorkbenchTurnSettlementController";
import type WorkbenchCoreThreadLookup from "./WorkbenchCoreThreadLookup";

export type WorkbenchCoreTranscript = Pick<DaemonTranscriptRegistration,
  | "read" | "readMaterializedTurnIds" | "readAbandonedHoldThreadIds" | "readContextUsage" | "readRecoveryGaps" | "isThreadObserved"
  | "record" | "subscribeItemActivity" | "subscribeContextCompaction" | "subscribeTurnStarted" | "subscribeHeldSteers"
  | "subscribeAgentMessageDelivery" | "subscribeSettled" | "acceptApprovalOutcome">;

type RuntimeListener = (threadId: string, change: Partial<ThreadRuntime> | null) => void;

function installedProvider(harness: string) {
  const key = installedProviderKeys.find(candidate => candidate === harness);
  if (!key) throw new Error(`Provider ${harness} is not installed.`);
  return key;
}

export default class WorkbenchTurnRuntimeFeature {
  readonly admission = new WorkbenchThreadAdmissionController();
  readonly turnLiveness: WorkbenchThreadTurnLiveness;
  readonly compaction: WorkbenchThreadCompactionController;
  readonly autoCompact: WorkbenchThreadAutoCompactController;
  readonly contextRollover: WorkbenchThreadContextRolloverController;
  readonly transcriptReader: WorkbenchTranscriptReader;
  readonly transcriptReconciliation: WorkbenchTranscriptReconciliationController;
  readonly continuations: WorkbenchTurnContinuationController;
  readonly turnSettlement: WorkbenchTurnSettlementController;
  readonly threadRuntime: DaemonRuntimeObjects["threadRuntime"];
  /** Threads whose runtime facts (token usage, auto-compaction) changed; thread observations reread them. */
  readonly #listeners = new Set<RuntimeListener>();
  readonly #shells: Pick<WorkbenchAgentMcpRequestRegistry,
    "readShellQueue" | "subscribeShellQueue" | "readShellOutput" | "readYieldedShells" | "subscribeShellOutput">;

  constructor(ports: {
    context: Pick<DaemonProcessContext, "logTurnRecovery">;
    database: DaemonDatabaseRegistration;
    transcript: WorkbenchCoreTranscript;
    turnRecovery: DaemonRuntimeObjects["turnRecovery"];
    identities: DaemonRuntimeObjects["threadIdentity"];
    lookup: WorkbenchCoreThreadLookup;
    settings: WorkbenchServerSettings;
    projectCatalog: WorkbenchProjectCatalogController;
    run: ReloadableNodeBuild<DaemonRuntimeObjects>["run"];
    /** Built after this feature, read at call time. */
    providers: () => WorkbenchProviderDispatcher;
    setSummaryFacts(threadId: string, facts: ThreadSummaryFacts): void;
    /** The thread's shown approval prompt; approvals are live provider facts, never durable thread state. */
    readPendingApproval(threadId: string): ThreadRuntime["pendingApproval"];
    /** Live wb shells' expensive-queue timing, newest output and yields, owned by the process-wide MCP request registry. */
    shells: Pick<WorkbenchAgentMcpRequestRegistry,
      "readShellQueue" | "subscribeShellQueue" | "readShellOutput" | "readYieldedShells" | "subscribeShellOutput">;
    warn(message: string): void;
  }) {
    this.#shells = ports.shells;
    const { context, database, transcript, identities, lookup, providers, warn } = ports;
    const admission = this.admission;
    const turnLiveness = this.turnLiveness = new WorkbenchThreadTurnLiveness({
      threads: harness => providers().get(installedProvider(harness)).threads,
      resolveHarness: async threadId => (await lookup.identity(threadId))?.bindings[0]?.harness ?? null,
      publish: (threadId, turnLive) => this.publish(threadId, { turnLive }),
      warn,
    });
    const compaction = this.compaction = new WorkbenchThreadCompactionController(admission, {
      record: transcript.record.bind(transcript),
      setCompacting: (threadId, compacting) => ports.setSummaryFacts(threadId, { compacting }),
      now: Date.now,
      warn: message => console.warn(`[compaction] ${message.slice(0, 500)}`),
      // The host resolves the current owner, so a retiring generation's queue reaches its replacement.
      handoff: (threadId, handoff) => ports.run("threadActions", actions => actions.adoptCompactionQueue(
        WorkbenchThreadIdSchema.parse(threadId), handoff,
      ), "compaction queue handoff"),
      readStrandedThreadIds: before => transcript.readAbandonedHoldThreadIds(before, "compactionQueue"),
    });
    const autoCompact = this.autoCompact = new WorkbenchThreadAutoCompactController(admission, compaction, {
      readSettings: () => ports.settings.readThreadAutoCompact(),
      readEvidence: async reference => {
        const entry = await lookup.entry(reference);
        if (!entry) return null;
        const usage = await database.readThreadContextUsage(entry.identity.threadId);
        return { activityAt: entry.activityAt, contextTokens: usage?.tokenUsage?.last.inputTokens ?? null };
      },
      // Status comes from the saved Workbench lifecycle; only the latest turn and its liveness are provider facts.
      readRuntime: async target => {
        const key = installedProvider(target.harness);
        const entry = await lookup.entry(target.threadId);
        const latestTurn = await ports.run(providerRegistrations[key], provider => provider.threads.latestTurn(target.threadId),
          `${key}: auto-compact latest turn`);
        return { latestTurn, status: threadPayloadStatus(entry), turnLive: await turnLiveness.read(target.threadId, target.harness) };
      },
      publish: (target, willAutoCompact) => this.publish(target.threadId, { willAutoCompact }),
      now: Date.now,
      warn: message => console.warn(`[auto-compact] ${message.slice(0, 500)}`),
    });
    this.contextRollover = new WorkbenchThreadContextRolloverController(admission, {
      readSelectedCap: async threadId => (await lookup.entry(threadId))?.profile?.settings.contextWindowTokens ?? null,
      requestDirective: async (threadId, turnId, instruction, key) => {
        const rollover = providers().get("opencode").threads.contextRollover;
        if (!rollover) throw new Error("OpenCode context rollover is unavailable.");
        await rollover.requestDirective({ instruction, key, threadId, turnId });
      },
      record: async observation => {
        await transcript.record([observation], { source: "provider" });
      },
      replace: async input => {
        const rollover = providers().get("opencode").threads.contextRollover;
        if (!rollover) throw new Error("OpenCode context rollover is unavailable.");
        await rollover.replace(input);
      },
      now: Date.now,
      warn: message => console.warn(`[context-rollover] ${message.slice(0, 500)}`),
    });
    const transcriptReader = this.transcriptReader = new WorkbenchTranscriptReader({
      readProviderCursor: (threadId, turnId) => database.readTranscriptProviderCursor!(threadId, turnId),
      readSnapshot: request => transcript.read(request),
      readContext: threadId => database.readTranscriptContext!(threadId),
      readMaterializedTurns: (threadId, turnIds) => transcript.readMaterializedTurnIds(threadId, turnIds),
      readContextUsage: threadId => transcript.readContextUsage(threadId),
      readApprovalOutcomes: (threadId, turnIds) => database.readApprovalOutcomes(threadId, turnIds),
      readMetadata: async (thread, provenance) => {
        const entry = await lookup.requireThreadState().controller.getCanonicalThreadEntry(
          ProjectIdSchema.parse(thread.project_id), WorkbenchThreadIdSchema.parse(thread.id),
        );
        let harness = (entry && entry.entryKind !== "draft" ? entry.identity.harness : null) ?? provenance;
        if (!harness) harness = (await lookup.identity(thread.id))?.bindings[0]?.harness ?? null;
        if (!harness) throw new Error("Canonical transcript has no stored execution provenance.");
        return { entry, harness: WorkbenchHarnessSchema.parse(harness) };
      },
    });
    this.transcriptReconciliation = new WorkbenchTranscriptReconciliationController({
      identities,
      transcripts: transcriptReader,
      isThreadObserved: threadId => transcript.isThreadObserved(threadId),
      readPreviousCursor: (threadId, turnId) => database.readTranscriptProviderCursor!(threadId, turnId),
      readMaterializedTurnIds: (threadId, turnIds) => transcript.readMaterializedTurnIds(threadId, turnIds),
      readRecoveryGaps: threadId => transcript.readRecoveryGaps(WorkbenchThreadIdSchema.parse(threadId)),
      subscribeSettled: listener => transcript.subscribeSettled(listener),
      lease: async (harness, work) => {
        const key = installedProvider(harness);
        await ports.run(providerRegistrations[key], () => work(), `${key}: transcript reconciliation`);
      },
      recover: async (input, signal) => {
        const provider = providers().get(installedProvider(input.harness));
        if (!provider.threads.reconcile) throw new Error("Transcript provider does not support reconciliation.");
        return provider.threads.reconcile(input, signal);
      },
      warn,
    });
    this.continuations = new WorkbenchTurnContinuationController({
      coordinator: ports.turnRecovery,
      readLifecycle: async (harness, threadId) => {
        const identity = await identities.resolve({ harness, threadId: ThreadReferenceSchema.parse(threadId) });
        if (!identity) return null;
        const entry = await lookup.requireThreadState().controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
        return entry && entry.entryKind !== "draft" ? { projectId: identity.projectId, lifecycle: entry.lifecycle } : null;
      },
      canonicalTurnId: reference => identities.knownTurn(TurnReferenceSchema.parse(reference)).turnId,
      interrupt: async (harness, threadId) => { await lookup.provider(harness).threads.interrupt(threadId); },
      admitHiddenTurn: async (harness, turn) => await providers().admitHiddenTurn(installedProvider(harness), turn),
      reportFailed: async (projectId, harness, threadId) => await lookup.requireThreadState().controller.reportRecoveryFailed(projectId, harness, threadId),
      log: context.logTurnRecovery,
    });
    this.turnSettlement = new WorkbenchTurnSettlementController({
      providers: { get: key => providers().get(key) }, identities, transcripts: transcriptReader, transcript,
      observe: async (harness, facts) => await lookup.requireThreadState().observeProviderNotification(harness, facts),
      listThreadLifecycles: async () => {
        const { data } = await ports.projectCatalog.readCatalog();
        const threads: Array<{ threadId: string; lifecycle: WorkbenchThreadLifecycle }> = [];
        for (const { id } of data) {
          const { entries } = await lookup.requireThreadState().controller.getSnapshot(ProjectIdSchema.parse(id));
          for (const entry of entries) {
            if (entry.entryKind !== "draft") threads.push({ threadId: entry.identity.threadId, lifecycle: entry.lifecycle });
          }
        }
        return threads;
      },
      readAbandonedHoldThreadIds: before => transcript.readAbandonedHoldThreadIds(before),
      warn,
    });
    const readTokenUsage = async (threadId: string) => (await transcript.readContextUsage(threadId))?.tokenUsage ?? null;
    this.threadRuntime = {
      // Stored facts arrive in one reader round trip; only liveness of in-progress turns asks providers.
      readMany: async entries => {
        if (!entries.length) return new Map();
        let facts: Awaited<ReturnType<typeof database.readThreadRuntimeFacts>>;
        try { facts = await database.readThreadRuntimeFacts(entries.map(({ identity }) => identity.threadId)); }
        catch (error) {
          warn(`Thread runtime read failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
          return new Map();
        }
        const turnLive = await Promise.all(entries.map(async ({ identity }, index) => {
          try { return await turnLiveness.observe(identity.threadId, identity.harness, facts[index]!.latestTurn); }
          catch (error) {
            warn(`Thread runtime turn liveness read failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
            return undefined;
          }
        }));
        const willAutoCompact = await autoCompact.observeMany(entries.map((entry, index) => ({
          target: { harness: WorkbenchHarnessSchema.parse(entry.identity.harness), threadId: entry.identity.threadId },
          evidence: { activityAt: entry.activityAt, contextTokens: facts[index]!.tokenUsage?.last.inputTokens ?? null },
          runtime: { latestTurn: facts[index]!.latestTurn, status: threadPayloadStatus(entry), turnLive: turnLive[index] ?? false },
        })));
        return new Map(entries.map(({ identity: { threadId } }, index) => {
          const { addressedFeedback, goal, skills, todos, tokenUsage } = facts[index]!;
          const live = turnLive[index];
          return [threadId, {
            tokenUsage, willAutoCompact: willAutoCompact.get(threadId) ?? false,
            ...(live !== undefined ? { turnLive: live } : {}),
            pendingApproval: ports.readPendingApproval(threadId),
            shellQueue: ports.shells.readShellQueue(WorkbenchThreadIdSchema.parse(threadId)),
            shellOutput: ports.shells.readShellOutput(WorkbenchThreadIdSchema.parse(threadId)),
            yieldedShells: ports.shells.readYieldedShells(WorkbenchThreadIdSchema.parse(threadId)),
            goal, skills, todos, addressedFeedback,
          }];
        }));
      },
      readTokenUsage,
      subscribe: listener => {
        this.#listeners.add(listener);
        // Token usage commits through the transcript; only usage is reread for committed threads.
        const stopSettled = transcript.subscribeSettled(threadIds => { for (const threadId of threadIds) listener(threadId, null); });
        return () => { this.#listeners.delete(listener); stopSettled(); };
      },
    };
  }

  /** Tell thread observations that one thread's runtime facts changed. */
  publish(threadId: string, change: Partial<ThreadRuntime>) {
    for (const listener of this.#listeners) listener(threadId, change);
  }

  /** Publishes each thread's shell queue, live shell output and yields as they change; returns the stop. */
  observeShells() {
    const stopQueue = this.#shells.subscribeShellQueue(threadId =>
      this.publish(threadId, { shellQueue: this.#shells.readShellQueue(threadId) }));
    const stopOutput = this.#shells.subscribeShellOutput(threadId => this.publish(threadId, {
      shellOutput: this.#shells.readShellOutput(threadId), yieldedShells: this.#shells.readYieldedShells(threadId),
    }));
    return () => { stopQueue(); stopOutput(); };
  }
}
