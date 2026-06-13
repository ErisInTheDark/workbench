/*
 * Exports:
 * - default migrateV4: queue inline transcript image extraction into hashed thread assets. Keywords: transcript, migration, image assets.
 * - queueCodexTranscriptImageAssetMigration: rerunnable bounded background migration for old inline transcript images. Keywords: transcript, image assets, migration.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type AtomicJsonStore from "../AtomicJsonStore";
import externalizeCodexTranscriptInlineImages from "../codex-transcript-image-assets";
import { log, logError } from "../process-helpers";

const FILE_BATCH_SIZE = 25;
const FILE_BATCH_DELAY_MS = 20;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
const ACTIVE_IMAGE_ASSET_MIGRATION_ROOTS_KEY = "__workbenchCodexTranscriptImageAssetMigrationRoots";

type MigrationGlobal = typeof globalThis & {
  [ACTIVE_IMAGE_ASSET_MIGRATION_ROOTS_KEY]?: Set<string>;
};

type MigrationCounts = {
  assets: number;
  errors: number;
  filesChanged: number;
  filesVisited: number;
  skipped: number;
  threadsVisited: number;
};

const migrationGlobal = globalThis as MigrationGlobal;
const activeMigrationRoots = migrationGlobal[ACTIVE_IMAGE_ASSET_MIGRATION_ROOTS_KEY] ??= new Set<string>();

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

async function migrateJsonFile(
  threadDirectoryPath: string,
  encodedThreadId: string,
  filePath: string,
  counts: MigrationCounts,
) {
  counts.filesVisited += 1;
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null || !raw.includes("data:image/")) {
    return;
  }

  const parsed = JSON.parse(raw) as unknown;
  const result = await externalizeCodexTranscriptInlineImages(parsed, {
    encodedThreadId,
    threadDirectoryPath,
  });
  if (!result.changed) {
    return;
  }

  await writeTextFileAtomically(filePath, `${JSON.stringify(result.value)}\n`);
  counts.assets += result.assetCount;
  counts.filesChanged += 1;
}

async function migrateJsonLinesFile(
  threadDirectoryPath: string,
  encodedThreadId: string,
  filePath: string,
  counts: MigrationCounts,
) {
  counts.filesVisited += 1;
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null || !raw.includes("data:image/")) {
    return;
  }

  let changed = false;
  let assetCount = 0;
  const nextLines: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const parsed = JSON.parse(trimmedLine) as unknown;
    const result = await externalizeCodexTranscriptInlineImages(parsed, {
      encodedThreadId,
      threadDirectoryPath,
    });
    nextLines.push(JSON.stringify(result.value));
    changed ||= result.changed;
    assetCount += result.assetCount;
  }

  if (!changed) {
    return;
  }

  await writeTextFileAtomically(filePath, `${nextLines.join("\n")}\n`);
  counts.assets += assetCount;
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

async function migrateTranscriptFile(
  threadDirectoryPath: string,
  encodedThreadId: string,
  filePath: string,
  counts: MigrationCounts,
) {
  try {
    if (filePath.endsWith(".ndjson")) {
      await migrateJsonLinesFile(threadDirectoryPath, encodedThreadId, filePath, counts);
      return;
    }
    await migrateJsonFile(threadDirectoryPath, encodedThreadId, filePath, counts);
  } catch (error) {
    counts.errors += 1;
    logError("codex-transcript", `inline image asset migration failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runBackgroundImageAssetMigration(rootDirectoryPath: string, counts: MigrationCounts) {
  const startedAt = Date.now();
  const threadsDirectoryPath = path.join(rootDirectoryPath, "threads");
  const threadDirectoryNames = await listThreadDirectoryNames(threadsDirectoryPath);
  let filesSinceYield = 0;
  let lastLoggedAt = Date.now();

  for (const encodedThreadId of threadDirectoryNames) {
    counts.threadsVisited += 1;
    const threadDirectoryPath = path.join(threadsDirectoryPath, encodedThreadId);
    const files = await listThreadTranscriptFiles(threadsDirectoryPath, encodedThreadId, counts);
    for (const filePath of files) {
      await migrateTranscriptFile(threadDirectoryPath, encodedThreadId, filePath, counts);
      filesSinceYield += 1;

      if (Date.now() - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastLoggedAt = Date.now();
        log("codex-transcript", [
          "inline image asset migration progress",
          `threads=${counts.threadsVisited}/${threadDirectoryNames.length}`,
          `filesVisited=${counts.filesVisited}`,
          `filesChanged=${counts.filesChanged}`,
          `assets=${counts.assets}`,
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
    "inline image asset migration finished",
    `threads=${counts.threadsVisited}`,
    `filesVisited=${counts.filesVisited}`,
    `filesChanged=${counts.filesChanged}`,
    `assets=${counts.assets}`,
    `errors=${counts.errors}`,
    `skipped=${counts.skipped}`,
    `durationMs=${Date.now() - startedAt}`,
  ].join(" "));
}

export async function queueCodexTranscriptImageAssetMigration(rootDirectoryPath: string) {
  const resolvedRootDirectoryPath = path.resolve(rootDirectoryPath);
  if (activeMigrationRoots.has(resolvedRootDirectoryPath)) {
    return;
  }
  activeMigrationRoots.add(resolvedRootDirectoryPath);

  const counts: MigrationCounts = {
    assets: 0,
    errors: 0,
    filesChanged: 0,
    filesVisited: 0,
    skipped: 0,
    threadsVisited: 0,
  };

  void runBackgroundImageAssetMigration(rootDirectoryPath, counts)
    .catch((error) => {
      logError("codex-transcript", `inline image asset migration failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      activeMigrationRoots.delete(resolvedRootDirectoryPath);
    });
}

export default async function migrateV4(rootDirectoryPath: string, _jsonStore: AtomicJsonStore) {
  await queueCodexTranscriptImageAssetMigration(rootDirectoryPath);
}
