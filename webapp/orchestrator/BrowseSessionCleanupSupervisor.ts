/*
 * Exports:
 * - BrowseSessionCleanupSupervisorOptions: injected thread-activity reader and cleanup timing knobs. Keywords: browse, cleanup, supervisor, orchestrator.
 * - default BrowseSessionCleanupSupervisor: long-lived orchestrator owner for stale Browse session cleanup. Keywords: browse, sessions, lifecycle, cleanup.
 */
import WorkbenchBrowseSessionController from "../lib/workbench/browse/WorkbenchBrowseSessionController";
import { logError } from "./process-helpers";

export interface BrowseSessionCleanupSupervisorOptions {
  inactiveCleanupMs?: number;
  intervalMs?: number;
  readThreadActive: (threadId: string) => Promise<boolean | null>;
}

const DEFAULT_BROWSE_SESSION_CLEANUP_POLL_MS = 3 * 60_000;
const DEFAULT_BROWSE_SESSION_INACTIVE_CLEANUP_MS = 30 * 60_000;

export default class BrowseSessionCleanupSupervisor {
  private inFlight = false;
  private readonly inactiveCleanupMs: number;
  private readonly intervalMs: number;
  private readonly readThreadActive: (threadId: string) => Promise<boolean | null>;
  private readonly sessionController = new WorkbenchBrowseSessionController();
  private timer: NodeJS.Timeout | null = null;

  constructor({
    inactiveCleanupMs = DEFAULT_BROWSE_SESSION_INACTIVE_CLEANUP_MS,
    intervalMs = DEFAULT_BROWSE_SESSION_CLEANUP_POLL_MS,
    readThreadActive,
  }: BrowseSessionCleanupSupervisorOptions) {
    this.inactiveCleanupMs = inactiveCleanupMs;
    this.intervalMs = intervalMs;
    this.readThreadActive = readThreadActive;
  }

  dispose() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce() {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.sessionController.cleanupStaleInactiveSessions({
        olderThanMs: this.inactiveCleanupMs,
        readThreadActive: this.readThreadActive,
      });
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        logError("browse-cleanup", error instanceof Error ? error.message : String(error));
      });
    }, this.intervalMs);
    this.timer.unref?.();
    void this.pollOnce().catch((error) => {
      logError("browse-cleanup", error instanceof Error ? error.message : String(error));
    });
  }
}
