/*
 * Exports:
 * - default WorkbenchDatabaseNode: own SQLite readiness, identity and transcript registrations, replacement and closure.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";

import type { DaemonProcessContext } from "./daemon-process-context";
import type {
  DaemonDatabaseRegistration,
  DaemonProviderNotification,
  DaemonRuntimeObjects,
  DaemonTranscriptRegistration,
} from "./daemon-runtime-objects";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import CodexConfigurationNode from "./CodexConfigurationNode";
import CodexRecoveryNode from "./CodexRecoveryNode";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import OpenCodeBridgeNode from "./providers/opencode/OpenCodeBridgeNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchBrowseNode from "./WorkbenchBrowseNode";
import WorkbenchInstructionsNode from "./WorkbenchInstructionsNode";
import WorkbenchCodexInstructionNode from "./WorkbenchCodexInstructionNode";

type DatabaseControllerConstructor = new (
  options: import("./database/WorkbenchDatabaseController").WorkbenchDatabaseControllerOptions,
) => DaemonDatabaseRegistration & Pick<
  import("./database/WorkbenchDatabaseController").default, "suspend" | "resume" | "abortPreparation" | "retireSuspendedAdmission" | "settleTranscript"
>;

interface DatabaseReloadState {
  checkpointPath: string | null;
  releaseCandidate?(): Promise<void>;
}

type ThreadIdentityControllerConstructor = new (
  database: DaemonDatabaseRegistration,
) => WorkbenchThreadIdentityController;

type TranscriptIdentityControllerConstructor = new (
  database: DaemonDatabaseRegistration,
) => WorkbenchTranscriptIdentityController;

type CaptureGapController = import("./database/transcript/WorkbenchTranscriptCaptureGapController").default;

type TranscriptControllerConstructor = new (
  database: DaemonDatabaseRegistration,
  captureGaps: CaptureGapController,
) => DaemonTranscriptRegistration;

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
  return { CaptureGapController, DatabaseController, ThreadIdentityController, TranscriptIdentityController, TranscriptController };
}

export default ReloadableNode.define<
  DaemonProcessContext,
  DaemonRuntimeObjects,
  DaemonProviderNotification
>()({
  access: "agent",
  boundarySources: [
    "daemon/server/lib/workbench/database/schema/**",
    "shared/workbench/database/schema/**",
    "shared/workbench/search/**",
    "shared/workbench/settings/**",
    "shared/workbench-data-root.ts",
    "daemon/server/database/**",
    "shared/database/**",
    "daemon/server/lib/project.ts",
    "daemon/server/lib/git.ts",
    "daemon/server/lib/workbench/project/project-identity.ts",
    "daemon/server/workbench-thread-state-record.ts",
  ].join("\n"),
  children: [CodexConfigurationNode, CodexRecoveryNode, WorkbenchInstructionsNode, WorkbenchCodexInstructionNode, WorkbenchCoreNode, WorkbenchAgentCommandNode, CodexBridgeNode, OpenCodeBridgeNode, WorkbenchWebSocketNode, WorkbenchMcpNode, WorkbenchBrowseNode],
  create: (context, build) => {
    const {
      CaptureGapController,
      DatabaseController,
      ThreadIdentityController,
      TranscriptIdentityController,
      TranscriptController,
    } = loadDatabaseControllers();
    const databasePath = join(context.dataRootPath, "daemon", "workbench.sqlite3");
    const handoffState = build.handoffState as DatabaseReloadState | undefined;
    const { discoverProjectIdentities } = require("./lib/project") as typeof import("./lib/project");
    const database = new DatabaseController({
      databasePath,
      prepareProjects: async signal => {
        const discovery = await discoverProjectIdentities(signal);
        signal.throwIfAborted();
        return { discovery };
      },
      beforeMigration: handoffState ? (backupPath) => { handoffState.checkpointPath = backupPath; } : undefined,
    });
    if (handoffState) handoffState.releaseCandidate = () => database.abortPreparation();
    const threadIdentity = new ThreadIdentityController(database);
    const transcriptIdentity = new TranscriptIdentityController(database);
    const captureGaps = new CaptureGapController({
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
    const transcript = new TranscriptController(database, captureGaps);
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
      registrations: { database, threadIdentity, transcriptIdentity, transcript },
      start: async (_reportPhase, signal) => {
        signal?.throwIfAborted();
        await mkdir(dirname(databasePath), { recursive: true });
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
  provides: ["database", "threadIdentity", "transcriptIdentity", "transcript"],
  requires: [],
  safeAll: true,
  scope: "server:database",
  sources: [
    "daemon/server/WorkbenchDatabaseNode.ts",
    "daemon/server/WorkbenchThreadIdentityController.ts",
    "daemon/server/WorkbenchTranscriptIdentityController.ts",
    "shared/workbench/thread/workbench-thread-items.ts",
    "shared/workbench/thread/workbench-thread-turn.ts",
    "shared/workbench/thread/thread-item-normalization.ts",
    "shared/workbench/thread/thread-runtime-state.ts",
    "shared/workbench/thread/thread-command-output.ts",
    "shared/workbench/thread/retained-transcript-identity.ts",
    "shared/workbench/provider/provider-observation.ts",
  ].join("\n"),
});
