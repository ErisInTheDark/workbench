/*
 * Exports:
 * - WorkbenchBrowseDownloadResult: completed managed-download metadata returned to BrowseMD scripts. Keywords: browse, download, result, browsemd.
 * - WorkbenchBrowseDownloadMonitorOptions: request-local managed-download monitor configuration. Keywords: browse, download, cwd, workspace.
 * - default WorkbenchBrowseDownloadMonitor: observes completed files in a Workbench-managed Browse download directory. Keywords: browse, download, monitor, lifecycle.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeRelativePath } from "../../project";

export interface WorkbenchBrowseDownloadResult {
  absolutePath: string;
  filename: string;
  mimeType: string | null;
  path: string;
  size: number;
}

export interface WorkbenchBrowseDownloadMonitorOptions {
  cwd: string;
  pollIntervalMs?: number;
  stableMs?: number;
  timeoutMs?: number;
  workspaceRootPaths: readonly string[];
}

interface DownloadCandidate {
  absolutePath: string;
  filename: string;
  modifiedTimeMs: number;
  path: string;
  size: number;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STABLE_MS = 750;
const INCOMPLETE_DOWNLOAD_EXTENSIONS = new Set([".crdownload", ".download", ".part", ".tmp"]);

export default class WorkbenchBrowseDownloadMonitor {
  private readonly claimedPaths = new Set<string>();
  private readonly cwd: string;
  private readonly pollIntervalMs: number;
  private readonly stableMs: number;
  private readonly timeoutMs: number;
  private readonly workspaceRootPaths: readonly string[];

  private baseline: Map<string, number> | null = null;

  constructor({
    cwd,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    stableMs = DEFAULT_STABLE_MS,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    workspaceRootPaths,
  }: WorkbenchBrowseDownloadMonitorOptions) {
    this.cwd = cwd;
    this.pollIntervalMs = pollIntervalMs;
    this.stableMs = stableMs;
    this.timeoutMs = timeoutMs;
    this.workspaceRootPaths = workspaceRootPaths;
  }

  async initialize() {
    this.baseline = await this.readDirectorySignature();
  }

  async waitForDownload(): Promise<WorkbenchBrowseDownloadResult> {
    if (!this.baseline) {
      await this.initialize();
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const candidate = await this.findNewestUnclaimedCandidate();
      if (candidate && await this.isStable(candidate)) {
        this.claimedPaths.add(candidate.absolutePath);
        return {
          absolutePath: candidate.absolutePath,
          filename: candidate.filename,
          mimeType: null,
          path: candidate.path,
          size: candidate.size,
        };
      }
      await delay(this.pollIntervalMs);
    }

    throw new Error(`Timed out waiting ${this.timeoutMs}ms for a Browse download in ${this.cwd}.`);
  }

  private async findNewestUnclaimedCandidate() {
    const baseline = this.baseline ?? new Map<string, number>();
    const entries = await fs.readdir(this.cwd, { withFileTypes: true });
    const candidates: DownloadCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (INCOMPLETE_DOWNLOAD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const absolutePath = path.resolve(this.cwd, entry.name);
      if (this.claimedPaths.has(absolutePath) || !this.isInsideWorkspace(absolutePath)) {
        continue;
      }
      const stats = await fs.stat(absolutePath);
      if (baseline.get(entry.name) === stats.mtimeMs) {
        continue;
      }
      candidates.push({
        absolutePath,
        filename: entry.name,
        modifiedTimeMs: stats.mtimeMs,
        path: normalizeRelativePath(path.relative(this.cwd, absolutePath)),
        size: stats.size,
      });
    }
    return candidates.sort((left, right) => right.modifiedTimeMs - left.modifiedTimeMs)[0] ?? null;
  }

  private async isStable(candidate: DownloadCandidate) {
    await delay(this.stableMs);
    try {
      const stats = await fs.stat(candidate.absolutePath);
      return stats.size === candidate.size && stats.mtimeMs === candidate.modifiedTimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async readDirectorySignature() {
    const signature = new Map<string, number>();
    const entries = await fs.readdir(this.cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const absolutePath = path.resolve(this.cwd, entry.name);
      const stats = await fs.stat(absolutePath);
      signature.set(entry.name, stats.mtimeMs);
    }
    return signature;
  }

  private isInsideWorkspace(candidatePath: string) {
    return this.workspaceRootPaths.some((rootPath) => {
      const relativePath = path.relative(rootPath, candidatePath);
      return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
    });
  }
}

async function delay(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
