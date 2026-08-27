/*
 * Exports:
 * - runCodexTranscriptMigrations: run ordered Codex transcript disk migrations. Keywords: transcript, migration, version.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type AtomicJsonStore from "../AtomicJsonStore";
import { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "../codex-transcript-version";
import type { OrchestratorTranscriptShadowLog } from "../orchestrator-runtime-objects";
import migrateV0 from "./v0";
import migrateV1 from "./v1";
import migrateV2 from "./v2";
import migrateV3 from "./v3";
import migrateV4 from "./v4";
import migrateV5 from "./v5";

const MIGRATIONS = [
  migrateV0,
  migrateV1,
  migrateV2,
  migrateV3,
  migrateV4,
  migrateV5,
] as const;

type MigrationState = {
  schemaVersion: number;
};

async function readMigrationState(filePath: string): Promise<MigrationState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (
      parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && typeof (parsed as { schemaVersion?: unknown }).schemaVersion === "number"
    ) {
      return { schemaVersion: (parsed as { schemaVersion: number }).schemaVersion };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  return { schemaVersion: 0 };
}

export async function runCodexTranscriptMigrations(
  rootDirectoryPath: string,
  jsonStore: AtomicJsonStore,
  shadowLog?: OrchestratorTranscriptShadowLog,
) {
  await fs.mkdir(rootDirectoryPath, { recursive: true });
  const stateFilePath = path.join(rootDirectoryPath, "migration.json");
  const state = await readMigrationState(stateFilePath);
  let didRunMigration = false;
  for (let version = state.schemaVersion; version < CODEX_TRANSCRIPT_SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new Error(`Missing Codex transcript migration v${version}.`);
    }

    shadowLog?.write({
      event: "legacy-migration-started",
      fields: { version },
      level: "info",
      source: "codex-transcript",
    });
    try {
      await migration(rootDirectoryPath, jsonStore, shadowLog);
    } catch (error) {
      shadowLog?.write({
        event: "legacy-migration-failed",
        fields: {
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          version,
        },
        level: "error",
        source: "codex-transcript",
      });
      throw error;
    }
    shadowLog?.write({
      event: "legacy-migration-completed",
      fields: { version },
      level: "info",
      source: "codex-transcript",
    });
    didRunMigration = true;
  }

  if (!didRunMigration && state.schemaVersion === CODEX_TRANSCRIPT_SCHEMA_VERSION) {
    return;
  }

  await jsonStore.write(stateFilePath, {
    migratedAt: Date.now(),
    schemaVersion: CODEX_TRANSCRIPT_SCHEMA_VERSION,
  });
}
