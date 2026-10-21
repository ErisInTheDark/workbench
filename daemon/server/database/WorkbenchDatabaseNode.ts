/*
 * Exports:
 * - default WorkbenchDatabaseNode: own SQLite readiness, identity and transcript registrations, periodic memory breakdown, replacement and closure;
 *   in-flight retention holds the daemon awake.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";

import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import WorkbenchCommandApprovalController from "../interactions/WorkbenchCommandApprovalController";
import WorkbenchThreadIdentityController from "../thread/WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "../transcript/WorkbenchTranscriptIdentityController";
import WorkbenchDatabaseController from "./WorkbenchDatabaseController";
import WorkbenchDatabaseRetentionController, { fileRetentionRecord } from "./retention/WorkbenchDatabaseRetentionController";
import WorkbenchTranscriptController from "./transcript/WorkbenchTranscriptController";
import WorkbenchTranscriptCaptureGapController from "./transcript/WorkbenchTranscriptCaptureGapController";
import WorkbenchMemoryReporter from "../runtime/WorkbenchMemoryReporter";
import CodexConfigurationNode from "../providers/codex/CodexConfigurationNode";
import ReloadableNode from "../runtime/ReloadableNode";
import CodexBridgeNode from "../providers/codex/CodexBridgeNode";
import OpenCodeBridgeNode from "../providers/opencode/OpenCodeBridgeNode";
import ClaudeBridgeNode from "../providers/claude/ClaudeBridgeNode";
import WorkbenchAgentCommandNode from "../agent/WorkbenchAgentCommandNode";
import WorkbenchCoreNode from "../core/WorkbenchCoreNode";
import WorkbenchWebSocketNode from "../transport/WorkbenchWebSocketNode";
import WorkbenchMcpNode from "../agent/WorkbenchMcpNode";
import WorkbenchBrowseNode from "../browse/WorkbenchBrowseNode";
import WorkbenchExecReaperNode from "../exec/WorkbenchExecReaperNode";
import WorkbenchInstructionsNode from "../agent/WorkbenchInstructionsNode";
import WorkbenchCodexInstructionNode from "../providers/codex/WorkbenchCodexInstructionNode";

interface DatabaseReloadState {
  checkpointPath: string | null;
  releaseCandidate?(): Promise<void>;
}

export default ReloadableNode.define<
  DaemonProcessContext,
  DaemonRuntimeObjects,
  DaemonProviderNotification
>()({
  access: "agent",
  children: [CodexConfigurationNode,WorkbenchInstructionsNode, WorkbenchCodexInstructionNode, WorkbenchCoreNode, WorkbenchAgentCommandNode, CodexBridgeNode, OpenCodeBridgeNode, ClaudeBridgeNode, WorkbenchWebSocketNode, WorkbenchMcpNode, WorkbenchBrowseNode, WorkbenchExecReaperNode],
  create: (context, build) => {
    const databasePath = join(context.dataRootPath, "daemon", "workbench.sqlite3");
    const handoffState = build.handoffState as DatabaseReloadState | undefined;
    const database = new WorkbenchDatabaseController({
      databasePath,
      beforeMigration: handoffState ? (backupPath) => { handoffState.checkpointPath = backupPath; } : undefined,
      onDiagnostic: context.reportDiagnostic,
    });
    if (handoffState) handoffState.releaseCandidate = () => database.abortPreparation();
    const threadIdentity = new WorkbenchThreadIdentityController(database);
    const commandApprovals = new WorkbenchCommandApprovalController(database);
    const transcriptIdentity = new WorkbenchTranscriptIdentityController(database);
    const captureGaps = new WorkbenchTranscriptCaptureGapController({
      database,
      resolveReference: async (reference) => {
        const thread = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(reference.threadId) });
        if (!thread) return reference;
        const turn = reference.turnId
          ? await threadIdentity.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(reference.turnId) })
          : null;
        return { threadId: thread.threadId, turnId: turn?.turnId ?? null };
      },
    });
    const transcript = new WorkbenchTranscriptController(database, captureGaps);
    const retention = new WorkbenchDatabaseRetentionController(database, undefined, undefined, () => transcript.observedThreadIds,
      fileRetentionRecord(join(context.dataRootPath, "daemon", "workbench-retention.json")));
    // The database owns the worker isolates, so their heaps are reported from here.
    const memory = new WorkbenchMemoryReporter({
      readWorkerHeaps: () => database.readWorkerHeaps(),
      log: line => process.stdout.write(`${line}\n`),
      warn: line => process.stderr.write(`${line}\n`),
    });
    let shutdownPromise: Promise<void> | null = null;
    let committed = build.mode !== "replacement";
    const shutdown = () => {
      shutdownPromise ??= (async () => {
        const failures: unknown[] = [];
        for (const close of [
          () => memory.dispose(),
          () => retention.dispose(),
          () => transcript.dispose(),
          () => threadIdentity.dispose(),
          () => transcriptIdentity.dispose(),
          () => committed ? database.close() : database.abortPreparation(),
        ]) {
          try { await close(); }
          catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Database node retirement failed.");
      })();
      return shutdownPromise;
    };
    return {
      activate: () => { committed = true; },
      deactivate: () => { committed = false; },
      // After the whole graph commits: samples during a stalled startup would read as liveness to the host watchdog.
      afterCommit: () => { memory.start(); retention.start(); },
      // Retirement begins after commit (or terminal shutdown), before dependant disposal.
      beginRuntimeDrain: () => database.retireSuspendedAdmission(),
      beginHandoff: () => {
        const state: DatabaseReloadState = { checkpointPath: null };
        return {
          waitForIdle: () => Promise.resolve(),
          expire: () => undefined,
          detach: async () => {
            await database.suspend();
            return state;
          },
          resume: async () => {
            await state.releaseCandidate?.();
            await database.resume(state.checkpointPath ?? undefined);
          },
          commit: shutdown,
        };
      },
      hasPendingWork: () => retention.hasPendingWork(),
      registrations: { database, commandApprovals, threadIdentity, transcriptIdentity, transcript },
      start: async (_reportPhase, signal) => {
        signal?.throwIfAborted();
        await mkdir(dirname(databasePath), { recursive: true });
        signal?.throwIfAborted();
        const databaseStartedAt = performance.now();
        const readinessPulse = setInterval(() => {
          console.info(`[startup] daemon database is still opening after ${Math.round((performance.now() - databaseStartedAt) / 1_000)}s`);
        }, 30_000);
        readinessPulse.unref();
        if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info("[startup] daemon database opening and verifying retained state");
        try { await transcript.start(); }
        finally { clearInterval(readinessPulse); }
        if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info(`[startup] daemon database and transcript ready in ${Math.round(performance.now() - databaseStartedAt)}ms`);
        signal?.throwIfAborted();
        const identitiesStartedAt = performance.now();
        await threadIdentity.start();
        signal?.throwIfAborted();
        if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info(`[startup] daemon thread identities ready in ${Math.round(performance.now() - identitiesStartedAt)}ms`);
      },
      detachForReload: shutdown,
      dispose: shutdown,
    };
  },
  description: "Reload the mandatory SQLite worker and every direct database dependant.",
  entries: [join(__dirname, "workbench-database-worker-bootstrap.mjs")],
  lifecycle: "handoff",
  provides: ["database", "commandApprovals", "threadIdentity", "transcriptIdentity", "transcript"],
  requires: [],
  safeAll: true,
  scope: "server:database",
});
