/*
 * Exports:
 * - default migrateV3: retire obsolete request sidecar directories through quick renames and bounded background deletion. Keywords: transcript, migration, request sidecars, cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";

import type AtomicJsonStore from "../AtomicJsonStore";
import { log, logError } from "../process-helpers";

const REQUEST_DIRECTORY_NAME = "requests";
const RETIRED_REQUEST_DIRECTORY_PREFIX = "requests.retired-";
const DELETE_BATCH_SIZE = 250;
const DELETE_BATCH_DELAY_MS = 25;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
const ACTIVE_CLEANUP_ROOTS_KEY = "__workbenchCodexTranscriptRequestSidecarCleanupRoots";

type CleanupGlobal = typeof globalThis & {
  [ACTIVE_CLEANUP_ROOTS_KEY]?: Set<string>;
};

const cleanupGlobal = globalThis as CleanupGlobal;
const activeCleanupRoots = cleanupGlobal[ACTIVE_CLEANUP_ROOTS_KEY] ??= new Set<string>();

type CleanupCounts = {
  deleted: number;
  errors: number;
  renamed: number;
  skipped: number;
  visited: number;
};

function isWithinDirectory(rootDirectoryPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootDirectoryPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function listThreadDirectories(threadsDirectoryPath: string) {
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

async function retireRequestDirectory(threadsDirectoryPath: string, threadDirectoryName: string, counts: CleanupCounts) {
  const threadDirectoryPath = path.join(threadsDirectoryPath, threadDirectoryName);
  const requestsDirectoryPath = path.join(threadDirectoryPath, REQUEST_DIRECTORY_NAME);
  if (!isWithinDirectory(threadsDirectoryPath, requestsDirectoryPath)) {
    counts.skipped += 1;
    return null;
  }

  const stats = await fs.lstat(requestsDirectoryPath).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }

    throw error;
  });
  if (!stats) {
    return null;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    counts.skipped += 1;
    return null;
  }

  const retiredDirectoryPath = path.join(threadDirectoryPath, `${RETIRED_REQUEST_DIRECTORY_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`);
  if (!isWithinDirectory(threadsDirectoryPath, retiredDirectoryPath)) {
    counts.skipped += 1;
    return null;
  }

  const renamed = await fs.rename(requestsDirectoryPath, retiredDirectoryPath).then(
    () => {
      counts.renamed += 1;
      return true;
    },
    () => {
      counts.errors += 1;
      return false;
    },
  );
  return renamed ? retiredDirectoryPath : null;
}

async function findRetiredRequestDirectories(threadsDirectoryPath: string, threadDirectoryName: string, counts: CleanupCounts) {
  const threadDirectoryPath = path.join(threadsDirectoryPath, threadDirectoryName);
  if (!isWithinDirectory(threadsDirectoryPath, threadDirectoryPath)) {
    counts.skipped += 1;
    return [];
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(threadDirectoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }

    counts.errors += 1;
    return [];
  }

  return entries
    .filter((entry) => entry.startsWith(RETIRED_REQUEST_DIRECTORY_PREFIX))
    .map((entry) => path.join(threadDirectoryPath, entry))
    .filter((entryPath) => isWithinDirectory(threadsDirectoryPath, entryPath));
}

async function deleteDirectoryInBatches(rootDirectoryPath: string, directoryPath: string, counts: CleanupCounts) {
  const pendingDirectories = [directoryPath];
  let pendingFiles: string[] = [];
  let lastLoggedAt = Date.now();

  while (pendingDirectories.length || pendingFiles.length) {
    while (pendingFiles.length < DELETE_BATCH_SIZE && pendingDirectories.length) {
      const currentDirectoryPath = pendingDirectories.pop()!;
      if (!isWithinDirectory(rootDirectoryPath, currentDirectoryPath)) {
        counts.skipped += 1;
        continue;
      }

      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(currentDirectoryPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          counts.errors += 1;
        }
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(currentDirectoryPath, entry.name);
        if (!isWithinDirectory(rootDirectoryPath, entryPath)) {
          counts.skipped += 1;
          continue;
        }

        counts.visited += 1;
        if (entry.isDirectory()) {
          pendingDirectories.push(entryPath);
        } else if (entry.isFile()) {
          pendingFiles.push(entryPath);
        } else {
          counts.skipped += 1;
        }
      }
    }

    const fileBatch = pendingFiles.splice(0, DELETE_BATCH_SIZE);
    await Promise.all(fileBatch.map((filePath) => fs.rm(filePath, { force: true }).then(
      () => {
        counts.deleted += 1;
      },
      () => {
        counts.errors += 1;
      },
    )));

    if (Date.now() - lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS) {
      lastLoggedAt = Date.now();
      log("codex-transcript", [
        "request sidecar cleanup progress",
        `deleted=${counts.deleted}`,
        `errors=${counts.errors}`,
        `renamed=${counts.renamed}`,
        `skipped=${counts.skipped}`,
        `visited=${counts.visited}`,
      ].join(" "));
    }

    if (pendingDirectories.length || pendingFiles.length) {
      await delay(DELETE_BATCH_DELAY_MS);
    }
  }

  await fs.rm(directoryPath, { force: true, recursive: true }).catch(() => undefined);
}

async function runBackgroundCleanup(threadsDirectoryPath: string, retiredDirectoryPaths: string[], counts: CleanupCounts) {
  const startedAt = Date.now();
  for (const retiredDirectoryPath of retiredDirectoryPaths) {
    await deleteDirectoryInBatches(threadsDirectoryPath, retiredDirectoryPath, counts);
  }

  log("codex-transcript", [
    "request sidecar cleanup finished",
    `deleted=${counts.deleted}`,
    `errors=${counts.errors}`,
    `renamed=${counts.renamed}`,
    `skipped=${counts.skipped}`,
    `visited=${counts.visited}`,
    `durationMs=${Date.now() - startedAt}`,
  ].join(" "));
}

export async function queueCodexTranscriptRequestSidecarCleanup(rootDirectoryPath: string) {
  const resolvedRootDirectoryPath = path.resolve(rootDirectoryPath);
  if (activeCleanupRoots.has(resolvedRootDirectoryPath)) {
    return;
  }
  activeCleanupRoots.add(resolvedRootDirectoryPath);

  const threadsDirectoryPath = path.join(rootDirectoryPath, "threads");
  const threadDirectoryNames = await listThreadDirectories(threadsDirectoryPath);
  const counts: CleanupCounts = {
    deleted: 0,
    errors: 0,
    renamed: 0,
    skipped: 0,
    visited: 0,
  };
  const retiredDirectoryPaths: string[] = [];

  for (const threadDirectoryName of threadDirectoryNames) {
    const retiredDirectoryPath = await retireRequestDirectory(threadsDirectoryPath, threadDirectoryName, counts);
    if (retiredDirectoryPath) {
      retiredDirectoryPaths.push(retiredDirectoryPath);
    }
    retiredDirectoryPaths.push(...await findRetiredRequestDirectories(threadsDirectoryPath, threadDirectoryName, counts));
  }

  log("codex-transcript", [
    "request sidecar retirement queued",
    `threads=${threadDirectoryNames.length}`,
    `retiredDirectories=${retiredDirectoryPaths.length}`,
    `renamed=${counts.renamed}`,
    `errors=${counts.errors}`,
  ].join(" "));

  void runBackgroundCleanup(threadsDirectoryPath, Array.from(new Set(retiredDirectoryPaths)), counts)
    .catch((error) => {
      logError("codex-transcript", `request sidecar cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      activeCleanupRoots.delete(resolvedRootDirectoryPath);
    });
}

export default async function migrateV3(rootDirectoryPath: string, _jsonStore: AtomicJsonStore) {
  await queueCodexTranscriptRequestSidecarCleanup(rootDirectoryPath);
}
