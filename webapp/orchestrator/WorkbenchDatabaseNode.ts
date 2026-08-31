/*
 * default WorkbenchDatabaseNode: own mandatory SQLite readiness, transcript domain registration, reload replacement, and closure. Keywords: database, transcript, graph, lifecycle.
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
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchTranscriptShadowLog from "./database/transcript/WorkbenchTranscriptShadowLog";
import { logError } from "./process-helpers";

type DatabaseControllerConstructor = new (
  options: { databasePath: string },
) => OrchestratorDatabaseRegistration;

type TranscriptControllerConstructor = new (
  database: OrchestratorDatabaseRegistration,
) => OrchestratorTranscriptRegistration;

const SQLITE_RESET_REQUEST = "workbench-sqlite-shadow-reset-v1\n";

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
  return { DatabaseController, TranscriptController };
}

export default new ReloadableNode<
  OrchestratorProcessContext,
  OrchestratorRuntimeObjects,
  OrchestratorProviderNotification
>({
  access: "agent",
  boundarySources: "webapp/orchestrator/database/**",
  children: [WorkbenchCoreNode, CodexBridgeNode, WorkbenchWebSocketNode],
  create: (context) => {
    const { DatabaseController, TranscriptController } = loadDatabaseControllers();
    const databasePath = join(context.legacyMigrationProjectRoot, ".workbench", "workbench.sqlite3");
    const resetRequestPath = join(context.legacyMigrationProjectRoot, ".workbench", "reset-workbench-sqlite");
    const shadowLogPath = join(context.legacyMigrationProjectRoot, ".workbench", "logs", "workbench-transcript-shadow.jsonl");
    const database = new DatabaseController({ databasePath });
    const transcript = new TranscriptController(database);
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
      registrations: { database, transcript, transcriptShadowLog },
      start: async () => {
        await mkdir(dirname(databasePath), { recursive: true });
        const resetRequest = await readSqliteResetRequest(resetRequestPath);
        if (resetRequest !== null) {
          if (resetRequest !== SQLITE_RESET_REQUEST) {
            throw new Error(`Unexpected SQLite reset request: ${resetRequestPath}`);
          }
          for (const target of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, shadowLogPath]) {
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
  provides: ["database", "transcript", "transcriptShadowLog"],
  requires: [],
  safeAll: true,
  scope: "server:database",
  sources: "webapp/orchestrator/WorkbenchDatabaseNode.ts",
});
