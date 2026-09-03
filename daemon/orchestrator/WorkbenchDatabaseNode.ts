/*
 * default WorkbenchDatabaseNode: own mandatory SQLite readiness, transcript and Codex sandbox network registrations, reload replacement, and closure. Keywords: database, transcript, Codex, network, graph, lifecycle.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type {
  OrchestratorDatabaseRegistration,
  OrchestratorProviderNotification,
  OrchestratorRuntimeObjects,
  OrchestratorTranscriptRegistration,
} from "./orchestrator-runtime-objects";
import type WorkbenchCodexSandboxNetworkController from "./WorkbenchCodexSandboxNetworkController";
import type { WorkbenchCodexSandboxNetworkDatabase } from "./WorkbenchCodexSandboxNetworkController";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchTranscriptShadowLog from "./database/transcript/WorkbenchTranscriptShadowLog";
import { logError } from "./process-helpers";

type DatabaseControllerConstructor = new (
  options: { databasePath: string },
) => OrchestratorDatabaseRegistration & WorkbenchCodexSandboxNetworkDatabase & {
  resetTranscript(): Promise<void>;
};

type CodexSandboxNetworkControllerConstructor = new (
  database: WorkbenchCodexSandboxNetworkDatabase,
) => WorkbenchCodexSandboxNetworkController;

type CaptureGapController = import("./database/transcript/WorkbenchTranscriptCaptureGapController").default;

type TranscriptControllerConstructor = new (
  database: OrchestratorDatabaseRegistration,
  captureGaps: CaptureGapController,
) => OrchestratorTranscriptRegistration;

type CaptureGapControllerConstructor = new (
  options: { markerPath: string },
) => CaptureGapController;

const TRANSCRIPT_RESET_REQUEST = "workbench-transcript-shadow-reset-v2\n";

async function readSqliteResetRequest(requestPath: string) {
  try {
    return await readFile(requestPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function loadDatabaseControllers() {
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
  return { CaptureGapController, CodexSandboxNetworkController, DatabaseController, TranscriptController };
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
    "daemon/orchestrator/database/**",
  ].join("\n"),
  children: [WorkbenchCoreNode, WorkbenchAgentCommandNode, CodexBridgeNode, WorkbenchWebSocketNode],
  create: (context) => {
    const {
      CaptureGapController,
      CodexSandboxNetworkController,
      DatabaseController,
      TranscriptController,
    } = loadDatabaseControllers();
    const databasePath = join(context.legacyMigrationProjectRoot, ".workbench", "workbench.sqlite3");
    const captureGapMarkerPath = join(
      context.legacyMigrationProjectRoot,
      ".workbench",
      "workbench-transcript-capture-gap.json",
    );
    const resetRequestPath = join(context.legacyMigrationProjectRoot, ".workbench", "reset-workbench-sqlite");
    const shadowLogPath = join(context.legacyMigrationProjectRoot, ".workbench", "logs", "workbench-transcript-shadow.jsonl");
    const database = new DatabaseController({ databasePath });
    const codexSandboxNetwork = new CodexSandboxNetworkController(database);
    const captureGaps = new CaptureGapController({ markerPath: captureGapMarkerPath });
    const transcript = new TranscriptController(database, captureGaps);
    const transcriptShadowLog = new WorkbenchTranscriptShadowLog(shadowLogPath, (error) => {
      logError("workbench-transcript-shadow", `internal diagnostic log failed: ${error.message}`);
    });
    let shutdownPromise: Promise<void> | null = null;
    const shutdown = () => {
      shutdownPromise ??= (async () => {
        transcript.dispose();
        await transcriptShadowLog.flush();
        await database.close();
      })();
      return shutdownPromise;
    };
    return {
      registrations: { codexSandboxNetwork, database, transcript, transcriptShadowLog },
      start: async () => {
        await mkdir(dirname(databasePath), { recursive: true });
        const resetRequest = await readSqliteResetRequest(resetRequestPath);
        if (resetRequest !== null) {
          if (resetRequest !== TRANSCRIPT_RESET_REQUEST) {
            throw new Error(`Unexpected transcript reset request: ${resetRequestPath}`);
          }
          await database.start();
          await database.resetTranscript();
          for (const target of [captureGapMarkerPath, shadowLogPath]) {
            await rm(target, { force: true });
          }
        }
        await transcriptShadowLog.start();
        await transcript.start();
        if (resetRequest !== null) await rm(resetRequestPath);
      },
      detachForReload: shutdown,
      dispose: shutdown,
    };
  },
  description: "Reload the mandatory SQLite worker and every direct database dependant.",
  lifecycle: "handoff",
  provides: ["codexSandboxNetwork", "database", "transcript", "transcriptShadowLog"],
  requires: [],
  safeAll: true,
  scope: "server:database",
  sources: [
    "daemon/orchestrator/WorkbenchDatabaseNode.ts",
    "daemon/orchestrator/WorkbenchCodexSandboxNetworkController.ts",
  ].join("\n"),
});
