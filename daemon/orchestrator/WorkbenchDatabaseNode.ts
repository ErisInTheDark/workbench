/*
 * Exports:
 * - default WorkbenchDatabaseNode: own SQLite readiness, identity, transcript and sandbox network registrations, replacement and closure.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";

import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type {
  OrchestratorDatabaseRegistration,
  OrchestratorProviderNotification,
  OrchestratorRuntimeObjects,
  OrchestratorTranscriptRegistration,
} from "./orchestrator-runtime-objects";
import type WorkbenchCodexSandboxNetworkController from "./WorkbenchCodexSandboxNetworkController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import type { WorkbenchCodexSandboxNetworkDatabase } from "./WorkbenchCodexSandboxNetworkController";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchTranscriptShadowLog from "./database/transcript/WorkbenchTranscriptShadowLog";
import { logError } from "./process-helpers";

type DatabaseControllerConstructor = new (
  options: { databasePath: string; beforeMigration?(backupPath: string): void },
) => OrchestratorDatabaseRegistration & WorkbenchCodexSandboxNetworkDatabase & Pick<
  import("./database/WorkbenchDatabaseController").default, "suspend" | "resume" | "abortPreparation" | "retireSuspendedAdmission"
>;

interface DatabaseReloadState {
  checkpointPath: string | null;
  releaseCandidate?(): Promise<void>;
}

type ThreadIdentityControllerConstructor = new (
  database: OrchestratorDatabaseRegistration,
) => WorkbenchThreadIdentityController;

type TranscriptIdentityControllerConstructor = new (
  database: OrchestratorDatabaseRegistration,
) => WorkbenchTranscriptIdentityController;

type CodexSandboxNetworkControllerConstructor = new (
  database: WorkbenchCodexSandboxNetworkDatabase,
) => WorkbenchCodexSandboxNetworkController;

type CaptureGapController = import("./database/transcript/WorkbenchTranscriptCaptureGapController").default;

type TranscriptControllerConstructor = new (
  database: OrchestratorDatabaseRegistration,
  captureGaps: CaptureGapController,
) => OrchestratorTranscriptRegistration;

type CaptureGapControllerConstructor = new (
  options: import("./database/transcript/WorkbenchTranscriptCaptureGapController").WorkbenchTranscriptCaptureGapControllerOptions,
) => CaptureGapController;

function loadDatabaseControllers() {
  const TranscriptIdentityController = (
    require("./WorkbenchTranscriptIdentityController") as { default: TranscriptIdentityControllerConstructor }
  ).default;
  const ThreadIdentityController = (
    require("./WorkbenchThreadIdentityController") as { default: ThreadIdentityControllerConstructor }
  ).default;
  const DatabaseController = (
    require("./database/WorkbenchDatabaseController") as { default: DatabaseControllerConstructor }
  ).default;
  const TranscriptController = (
    require("./database/transcript/WorkbenchTranscriptController") as { default: TranscriptControllerConstructor }
  ).default;
  const CaptureGapController = (
    require("./database/transcript/WorkbenchTranscriptCaptureGapController") as { default: CaptureGapControllerConstructor }
  ).default;
  const CodexSandboxNetworkController = (
    require("./WorkbenchCodexSandboxNetworkController") as {
      default: CodexSandboxNetworkControllerConstructor;
    }
  ).default;
  return { CaptureGapController, CodexSandboxNetworkController, DatabaseController, ThreadIdentityController, TranscriptIdentityController, TranscriptController };
}

export default new ReloadableNode<
  OrchestratorProcessContext,
  OrchestratorRuntimeObjects,
  OrchestratorProviderNotification
>({
  access: "agent",
  boundarySources: [
    "daemon/lib/workbench/database/schema/**",
    "shared/workbench/database/schema/**",
    "shared/workbench/search/**",
    "shared/workbench/settings/**",
    "daemon/orchestrator/database/**",
    "shared/database/**",
  ].join("\n"),
  children: [WorkbenchCoreNode, WorkbenchAgentCommandNode, CodexBridgeNode, OpenCodeBridgeNode, WorkbenchWebSocketNode, WorkbenchMcpNode, WorkbenchBrowseNode],
  create: (context, build) => {
    const {
      CaptureGapController,
      CodexSandboxNetworkController,
      DatabaseController,
      ThreadIdentityController,
      TranscriptIdentityController,
      TranscriptController,
    } = loadDatabaseControllers();
    const databasePath = join(context.legacyMigrationProjectRoot, ".workbench", "workbench.sqlite3");
    const captureGapMarkerPath = join(
      context.legacyMigrationProjectRoot,
      ".workbench",
      "workbench-transcript-capture-gap.json",
    );
    const shadowLogPath = join(context.legacyMigrationProjectRoot, ".workbench", "logs", "workbench-transcript-shadow.jsonl");
    const handoffState = build.handoffState as DatabaseReloadState | undefined;
    const database = new DatabaseController({
      databasePath,
      beforeMigration: handoffState ? (backupPath) => { handoffState.checkpointPath = backupPath; } : undefined,
    });
    if (handoffState) handoffState.releaseCandidate = () => database.abortPreparation();
    const threadIdentity = new ThreadIdentityController(database);
    const transcriptIdentity = new TranscriptIdentityController(database);
    const codexSandboxNetwork = new CodexSandboxNetworkController(database);
    const captureGaps = new CaptureGapController({
      markerPath: captureGapMarkerPath,
      resolveReference: async (reference) => {
        const thread = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(reference.threadId) });
        if (!thread) return reference;
        const turn = reference.turnId
          ? await threadIdentity.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(reference.turnId) })
          : null;
        return { threadId: thread.threadId, turnId: turn?.turnId ?? reference.turnId };
      },
    });
    const transcript = new TranscriptController(database, captureGaps);
    const transcriptShadowLog = new WorkbenchTranscriptShadowLog(shadowLogPath, (error) => {
      logError("workbench-transcript-shadow", `internal diagnostic log failed: ${error.message}`);
    });
    let shutdownPromise: Promise<void> | null = null;
    let committed = build.mode !== "replacement";
    const shutdown = () => {
      shutdownPromise ??= (async () => {
        const failures: unknown[] = [];
        for (const close of [
          () => transcript.dispose(),
          () => threadIdentity.dispose(),
          () => transcriptIdentity.dispose(),
          () => transcriptShadowLog.flush(),
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
            await transcriptShadowLog.flush();
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
      registrations: { codexSandboxNetwork, database, threadIdentity, transcriptIdentity, transcript, transcriptShadowLog },
      start: async (_reportPhase, signal) => {
        signal?.throwIfAborted();
        await mkdir(dirname(databasePath), { recursive: true });
        signal?.throwIfAborted();
        await transcriptShadowLog.start();
        signal?.throwIfAborted();
        await transcript.start();
        signal?.throwIfAborted();
        await threadIdentity.start();
        signal?.throwIfAborted();
      },
      detachForReload: shutdown,
      dispose: shutdown,
    };
  },
  description: "Reload the mandatory SQLite worker and every direct database dependant.",
  lifecycle: "handoff",
  provides: ["codexSandboxNetwork", "database", "threadIdentity", "transcriptIdentity", "transcript", "transcriptShadowLog"],
  requires: [],
  safeAll: true,
  scope: "server:database",
  sources: [
    "daemon/orchestrator/WorkbenchDatabaseNode.ts",
    "daemon/orchestrator/WorkbenchCodexSandboxNetworkController.ts",
    "daemon/orchestrator/WorkbenchThreadIdentityController.ts",
    "daemon/orchestrator/WorkbenchTranscriptIdentityController.ts",
  ].join("\n"),
});
