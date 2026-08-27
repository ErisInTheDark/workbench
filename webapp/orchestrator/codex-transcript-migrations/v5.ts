/*
 * Exports:
 * - default migrateV5: await oversized command output compaction in transcript files. Keywords: transcript, migration, command output.
 * - queueCodexTranscriptCommandOutputCompactionMigration: coalesce and await command output migration by transcript root. Keywords: transcript, command output, migration.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { compactCommandOutputPayload } from "../../lib/codex/thread-command-output";
import type AtomicJsonStore from "../AtomicJsonStore";
import type { OrchestratorTranscriptShadowLog } from "../orchestrator-runtime-objects";

const FILE_BATCH_SIZE = 25;
const FILE_BATCH_DELAY_MS = 20;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
const ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY = "__workbenchCodexTranscriptCommandOutputCompactionRoots";

type MigrationGlobal = typeof globalThis & {
  [ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY]?: Map<string, Promise<void>> | Set<string>;
};

type MigrationCounts = {
  errors: number;
  filesChanged: number;
  filesVisited: number;
  skipped: number;
  threadsVisited: number;
};

const migrationGlobal = globalThis as MigrationGlobal;
const existingActiveMigrationRoots = migrationGlobal[ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY];
const activeMigrationsByRoot = existingActiveMigrationRoots instanceof Map
  ? existingActiveMigrationRoots
  : new Map<string, Promise<void>>();
migrationGlobal[ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY] = activeMigrationsByRoot;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isWithinDirectory(rootDirectoryPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootDirectoryPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function mayContainCommandOutput(raw: string) {
  return raw.includes('"aggregatedOutput"') || raw.includes("item/commandExecution/outputDelta");
}

async function listThreadDirectoryNames(threadsDirectoryPath: string) {
  try {
    return (await fs.readdir(threadsDirectoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeTextFileAtomically(filePath: string, content: string) {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function migrateJsonFile(filePath: string, counts: MigrationCounts) {
  counts.filesVisited += 1;
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null || !mayContainCommandOutput(raw)) {
    return;
  }

  const parsed = JSON.parse(raw) as unknown;
  const compacted = compactCommandOutputPayload(parsed);
  if (compacted === parsed) {
    return;
  }

  await writeTextFileAtomically(filePath, `${JSON.stringify(compacted)}\n`);
  counts.filesChanged += 1;
}

async function migrateJsonLinesFile(filePath: string, counts: MigrationCounts) {
  counts.filesVisited += 1;
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const tempFile = await fs.open(tempPath, "wx");
  let changed = false;
  try {
    const lines = createInterface({
      crlfDelay: Infinity,
      input: createReadStream(filePath, { encoding: "utf8" }),
    });
    for await (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      if (!mayContainCommandOutput(trimmedLine)) {
        await tempFile.write(`${trimmedLine}\n`);
        continue;
      }

      const parsed = JSON.parse(trimmedLine) as unknown;
      const compacted = compactCommandOutputPayload(parsed);
      await tempFile.write(`${compacted === parsed ? trimmedLine : JSON.stringify(compacted)}\n`);
      changed ||= compacted !== parsed;
    }

    await tempFile.close();
    if (!changed) {
      await fs.rm(tempPath, { force: true });
      return;
    }

    await fs.rename(tempPath, filePath);
    counts.filesChanged += 1;
  } catch (error) {
    await tempFile.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function listTurnTranscriptFiles(threadDirectoryPath: string, counts: MigrationCounts) {
  const turnsDirectoryPath = path.join(threadDirectoryPath, "turns");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(turnsDirectoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    counts.errors += 1;
    return [];
  }

  return entries
    .filter((entry) => entry.endsWith(".json") || entry.endsWith(".ndjson"))
    .map((entry) => path.join(turnsDirectoryPath, entry));
}

async function listThreadTranscriptFiles(threadsDirectoryPath: string, encodedThreadId: string, counts: MigrationCounts) {
  const threadDirectoryPath = path.join(threadsDirectoryPath, encodedThreadId);
  if (!isWithinDirectory(threadsDirectoryPath, threadDirectoryPath)) {
    counts.skipped += 1;
    return [];
  }

  return [
    path.join(threadDirectoryPath, "thread.json"),
    path.join(threadDirectoryPath, "orphan-events.json"),
    path.join(threadDirectoryPath, "orphan-events.ndjson"),
    ...await listTurnTranscriptFiles(threadDirectoryPath, counts),
  ].filter((filePath) => isWithinDirectory(threadDirectoryPath, filePath));
}

async function migrateTranscriptFile(
  filePath: string,
  counts: MigrationCounts,
  shadowLog?: OrchestratorTranscriptShadowLog,
) {
  try {
    if (filePath.endsWith(".ndjson")) {
      await migrateJsonLinesFile(filePath, counts);
      return;
    }
    await migrateJsonFile(filePath, counts);
  } catch (error) {
    counts.errors += 1;
    shadowLog?.write({
      event: "command-output-file-compaction-failed",
      fields: {
        filePath: filePath.slice(0, 500),
        message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
      level: "error",
      source: "codex-transcript",
    });
  }
}

async function runBackgroundCommandOutputCompaction(
  rootDirectoryPath: string,
  counts: MigrationCounts,
  shadowLog?: OrchestratorTranscriptShadowLog,
) {
  const startedAt = Date.now();
  const threadsDirectoryPath = path.join(rootDirectoryPath, "threads");
  const threadDirectoryNames = await listThreadDirectoryNames(threadsDirectoryPath);
  if (threadDirectoryNames.length === 0) return;
  let filesSinceYield = 0;
  let lastLoggedAt = Date.now();

  for (const encodedThreadId of threadDirectoryNames) {
    counts.threadsVisited += 1;
    const files = await listThreadTranscriptFiles(threadsDirectoryPath, encodedThreadId, counts);
    for (const filePath of files) {
      await migrateTranscriptFile(filePath, counts, shadowLog);
      filesSinceYield += 1;

      if (Date.now() - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastLoggedAt = Date.now();
        shadowLog?.write({
          event: "command-output-compaction-progress",
          fields: { ...counts, totalThreads: threadDirectoryNames.length },
          level: "info",
          source: "codex-transcript",
        });
      }

      if (filesSinceYield >= FILE_BATCH_SIZE) {
        filesSinceYield = 0;
        await delay(FILE_BATCH_DELAY_MS);
      }
    }
  }

  shadowLog?.write({
    event: "command-output-compaction-completed",
    fields: { ...counts, durationMs: Date.now() - startedAt },
    level: "info",
    source: "codex-transcript",
  });
}

export async function queueCodexTranscriptCommandOutputCompactionMigration(
  rootDirectoryPath: string,
  shadowLog?: OrchestratorTranscriptShadowLog,
) {
  const resolvedRootDirectoryPath = path.resolve(rootDirectoryPath);
  const activeMigration = activeMigrationsByRoot.get(resolvedRootDirectoryPath);
  if (activeMigration) {
    return await activeMigration;
  }

  const counts: MigrationCounts = {
    errors: 0,
    filesChanged: 0,
    filesVisited: 0,
    skipped: 0,
    threadsVisited: 0,
  };

  const migration = runBackgroundCommandOutputCompaction(rootDirectoryPath, counts, shadowLog)
    .catch((error) => {
      shadowLog?.write({
        event: "command-output-compaction-failed",
        fields: { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
        level: "error",
        source: "codex-transcript",
      });
      throw error;
    });
  activeMigrationsByRoot.set(resolvedRootDirectoryPath, migration);
  const clearActiveMigration = () => {
    if (activeMigrationsByRoot.get(resolvedRootDirectoryPath) === migration) {
      activeMigrationsByRoot.delete(resolvedRootDirectoryPath);
    }
  };
  void migration.then(clearActiveMigration, clearActiveMigration);
  return await migration;
}

export default async function migrateV5(
  rootDirectoryPath: string,
  _jsonStore: AtomicJsonStore,
  shadowLog?: OrchestratorTranscriptShadowLog,
) {
  await queueCodexTranscriptCommandOutputCompactionMigration(rootDirectoryPath, shadowLog);
}
