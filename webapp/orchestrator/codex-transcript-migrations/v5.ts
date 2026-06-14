/*
 * Exports:
 * - default migrateV5: queue oversized command output compaction in transcript files. Keywords: transcript, migration, command output.
 * - queueCodexTranscriptCommandOutputCompactionMigration: rerunnable bounded background migration for old oversized command output. Keywords: transcript, command output, migration.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { compactCommandOutputPayload } from "../../lib/codex/thread-command-output";
import type AtomicJsonStore from "../AtomicJsonStore";
import { log, logError } from "../process-helpers";

const FILE_BATCH_SIZE = 25;
const FILE_BATCH_DELAY_MS = 20;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
const ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY = "__workbenchCodexTranscriptCommandOutputCompactionRoots";

type MigrationGlobal = typeof globalThis & {
  [ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY]?: Set<string>;
};

type MigrationCounts = {
  errors: number;
  filesChanged: number;
  filesVisited: number;
  skipped: number;
  threadsVisited: number;
};

const migrationGlobal = globalThis as MigrationGlobal;
const activeMigrationRoots = migrationGlobal[ACTIVE_COMMAND_OUTPUT_COMPACTION_ROOTS_KEY] ??= new Set<string>();

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
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null || !mayContainCommandOutput(raw)) {
    return;
  }

  let changed = false;
  const nextLines: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const parsed = JSON.parse(trimmedLine) as unknown;
    const compacted = compactCommandOutputPayload(parsed);
    nextLines.push(JSON.stringify(compacted));
    changed ||= compacted !== parsed;
  }

  if (!changed) {
    return;
  }

  await writeTextFileAtomically(filePath, `${nextLines.join("\n")}\n`);
  counts.filesChanged += 1;
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

async function migrateTranscriptFile(filePath: string, counts: MigrationCounts) {
  try {
    if (filePath.endsWith(".ndjson")) {
      await migrateJsonLinesFile(filePath, counts);
      return;
    }
    await migrateJsonFile(filePath, counts);
  } catch (error) {
    counts.errors += 1;
    logError("codex-transcript", `command output compaction failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runBackgroundCommandOutputCompaction(rootDirectoryPath: string, counts: MigrationCounts) {
  const startedAt = Date.now();
  const threadsDirectoryPath = path.join(rootDirectoryPath, "threads");
  const threadDirectoryNames = await listThreadDirectoryNames(threadsDirectoryPath);
  let filesSinceYield = 0;
  let lastLoggedAt = Date.now();

  for (const encodedThreadId of threadDirectoryNames) {
    counts.threadsVisited += 1;
    const files = await listThreadTranscriptFiles(threadsDirectoryPath, encodedThreadId, counts);
    for (const filePath of files) {
      await migrateTranscriptFile(filePath, counts);
      filesSinceYield += 1;

      if (Date.now() - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastLoggedAt = Date.now();
        log("codex-transcript", [
          "command output compaction progress",
          `threads=${counts.threadsVisited}/${threadDirectoryNames.length}`,
          `filesVisited=${counts.filesVisited}`,
          `filesChanged=${counts.filesChanged}`,
          `errors=${counts.errors}`,
          `skipped=${counts.skipped}`,
        ].join(" "));
      }

      if (filesSinceYield >= FILE_BATCH_SIZE) {
        filesSinceYield = 0;
        await delay(FILE_BATCH_DELAY_MS);
      }
    }
  }

  log("codex-transcript", [
    "command output compaction finished",
    `threads=${counts.threadsVisited}`,
    `filesVisited=${counts.filesVisited}`,
    `filesChanged=${counts.filesChanged}`,
    `errors=${counts.errors}`,
    `skipped=${counts.skipped}`,
    `durationMs=${Date.now() - startedAt}`,
  ].join(" "));
}

export async function queueCodexTranscriptCommandOutputCompactionMigration(rootDirectoryPath: string) {
  const resolvedRootDirectoryPath = path.resolve(rootDirectoryPath);
  if (activeMigrationRoots.has(resolvedRootDirectoryPath)) {
    return;
  }
  activeMigrationRoots.add(resolvedRootDirectoryPath);

  const counts: MigrationCounts = {
    errors: 0,
    filesChanged: 0,
    filesVisited: 0,
    skipped: 0,
    threadsVisited: 0,
  };

  void runBackgroundCommandOutputCompaction(rootDirectoryPath, counts)
    .catch((error) => {
      logError("codex-transcript", `command output compaction failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      activeMigrationRoots.delete(resolvedRootDirectoryPath);
    });
}

export default async function migrateV5(rootDirectoryPath: string, _jsonStore: AtomicJsonStore) {
  await queueCodexTranscriptCommandOutputCompactionMigration(rootDirectoryPath);
}
