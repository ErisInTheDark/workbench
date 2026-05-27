/*
 * Exports:
 * - default migrateV2: delete old request raw journals with progress logging. Keywords: transcript, migration, request journals, cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Dir, Dirent } from "node:fs";

import type AtomicJsonStore from "../AtomicJsonStore";
import { log } from "../process-helpers";

const PROGRESS_LOG_INTERVAL_MS = 5_000;
const PROGRESS_LOG_PERCENT_STEP = 5;

type CleanupCounts = {
  deleted: number;
  errors: number;
  skipped: number;
  threadDirectories: number;
  visited: number;
};

function isRequestJournal(fileName: string) {
  return fileName.endsWith(".ndjson");
}

function isWithinDirectory(rootDirectoryPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootDirectoryPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

async function listThreadDirectories(threadsDirectoryPath: string) {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(threadsDirectoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function shouldLogProgress({
  lastLoggedAt,
  lastLoggedPercent,
  percent,
}: {
  lastLoggedAt: number;
  lastLoggedPercent: number;
  percent: number;
}) {
  return percent >= 100
    || percent - lastLoggedPercent >= PROGRESS_LOG_PERCENT_STEP
    || Date.now() - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS;
}

async function deleteRequestJournals(
  threadsDirectoryPath: string,
  threadDirectoryName: string,
  counts: CleanupCounts,
) {
  const threadDirectoryPath = path.join(threadsDirectoryPath, threadDirectoryName);
  const requestsDirectoryPath = path.join(threadDirectoryPath, "requests");
  if (!isWithinDirectory(threadsDirectoryPath, requestsDirectoryPath)) {
    counts.skipped += 1;
    return;
  }

  let directory: Dir | null = null;
  try {
    directory = await fs.opendir(requestsDirectoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }

    counts.errors += 1;
    return;
  }

  try {
    for await (const entry of directory) {
      counts.visited += 1;
      if (!entry.isFile() || !isRequestJournal(entry.name)) {
        continue;
      }

      const entryPath = path.join(requestsDirectoryPath, entry.name);
      if (!isWithinDirectory(threadsDirectoryPath, entryPath)) {
        counts.skipped += 1;
        continue;
      }

      await fs.rm(entryPath, { force: true }).then(
        () => {
          counts.deleted += 1;
        },
        () => {
          counts.errors += 1;
        },
      );
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

export default async function migrateV2(rootDirectoryPath: string, _jsonStore: AtomicJsonStore) {
  const startedAt = Date.now();
  const threadsDirectoryPath = path.join(rootDirectoryPath, "threads");
  const threadDirectories = await listThreadDirectories(threadsDirectoryPath);
  const total = threadDirectories.length;
  const counts: CleanupCounts = {
    deleted: 0,
    errors: 0,
    skipped: 0,
    threadDirectories: total,
    visited: 0,
  };
  let lastLoggedAt = 0;
  let lastLoggedPercent = -PROGRESS_LOG_PERCENT_STEP;

  log("codex-transcript", `request journal cleanup started root=${threadsDirectoryPath} threadDirectories=${total}`);

  for (const [index, threadDirectoryName] of threadDirectories.entries()) {
    await deleteRequestJournals(threadsDirectoryPath, threadDirectoryName, counts);
    const completed = index + 1;
    const percent = total ? Math.floor((completed / total) * 100) : 100;
    if (shouldLogProgress({ lastLoggedAt, lastLoggedPercent, percent })) {
      lastLoggedAt = Date.now();
      lastLoggedPercent = percent;
      log("codex-transcript", [
        "request journal cleanup progress",
        `percent=${percent}`,
        `threads=${completed}/${total}`,
        `deleted=${counts.deleted}`,
        `errors=${counts.errors}`,
        `skipped=${counts.skipped}`,
        `visited=${counts.visited}`,
      ].join(" "));
    }
  }

  log("codex-transcript", [
    "request journal cleanup finished",
    "percent=100",
    `threadDirectories=${counts.threadDirectories}`,
    `deleted=${counts.deleted}`,
    `errors=${counts.errors}`,
    `skipped=${counts.skipped}`,
    `visited=${counts.visited}`,
    `durationMs=${Date.now() - startedAt}`,
  ].join(" "));
}
