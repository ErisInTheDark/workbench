/*
 * Exports:
 * - default WorkbenchDatabaseNode: own SQLite readiness, identity and transcript registrations, replacement and closure.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";

import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import WorkbenchCommandApprovalController from "./WorkbenchCommandApprovalController";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchTranscriptController from "./database/transcript/WorkbenchTranscriptController";
import WorkbenchTranscriptCaptureGapController from "./database/transcript/WorkbenchTranscriptCaptureGapController";
import CodexConfigurationNode from "./CodexConfigurationNode";
import CodexRecoveryNode from "./CodexRecoveryNode";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import OpenCodeBridgeNode from "./providers/opencode/OpenCodeBridgeNode";
import ClaudeBridgeNode from "./providers/claude/ClaudeBridgeNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchInstructionsNode from "./WorkbenchInstructionsNode";
import WorkbenchCodexInstructionNode from "./WorkbenchCodexInstructionNode";

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
  children: [CodexConfigurationNode, CodexRecoveryNode, WorkbenchInstructionsNode, WorkbenchCodexInstructionNode, WorkbenchCoreNode, WorkbenchAgentCommandNode, CodexBridgeNode, OpenCodeBridgeNode, ClaudeBridgeNode, WorkbenchWebSocketNode, WorkbenchMcpNode, WorkbenchBrowseNode],
  create: (context, build) => {
    const databasePath = join(context.dataRootPath, "daemon", "workbench.sqlite3");
    const handoffState = build.handoffState as DatabaseReloadState | undefined;
    const database = new WorkbenchDatabaseController({
      databasePath,
      beforeMigration: handoffState ? (backupPath) => { handoffState.checkpointPath = backupPath; } : undefined,
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
    let shutdownPromise: Promise<void> | null = null;
    let committed = build.mode !== "replacement";
    const shutdown = () => {
      shutdownPromise ??= (async () => {
        const failures: unknown[] = [];
        for (const close of [
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
      registrations: { database, commandApprovals, threadIdentity, transcriptIdentity, transcript },
      start: async (_reportPhase, signal) => {
        signal?.throwIfAborted();
        await mkdir(dirname(databasePath), { recursive: true });
        signal?.throwIfAborted();
        const databaseStartedAt = performance.now();
        if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info("[startup] daemon database opening and verifying retained state");
        await transcript.start();
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
  entries: [join(__dirname, "database", "workbench-database-worker-bootstrap.mjs")],
  lifecycle: "handoff",
  provides: ["database", "commandApprovals", "threadIdentity", "transcriptIdentity", "transcript"],
  requires: [],
  safeAll: true,
  scope: "server:database",
});
