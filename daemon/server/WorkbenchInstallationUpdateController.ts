/*
 * Exports:
 * - default WorkbenchInstallationUpdateController: own running-checkout fetches, upstream prediction and leased pulls through
 *   WorkbenchGitIntegration, repair failure and background checks.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import {
  INSTALLATION_REPAIR_JOURNAL_SEGMENTS, INSTALLATION_UPDATE_MAX_CONFLICTS,
  InstallationRepairJournalSchema,
  type InstallationRepairJournal, type InstallationUpdate, type InstallationPullResult,
} from "workbench-shared/workbench/installation-update";
import type { ProjectId } from "workbench-shared/workbench/identity";
import WorkbenchGitIntegration from "./lib/workbench/git/WorkbenchGitIntegration";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import watchGitRefs from "./lib/workbench/git/git-ref-watch";
import type { createWorktreeGitTransitions } from "./worktree-git-transitions";

type GitResult = { code: number; stdout: string; stderr: string };
type Options = {
  repoRoot: string;
  dataRoot?: string;
  transitions: Pick<ReturnType<typeof createWorktreeGitTransitions>, "run" | "read">;
  projectId(): Promise<ProjectId | null>;
  warn(message: string): void;
  schedule?: (check: () => void) => () => void;
  watch?: (changed: () => void) => (() => void) | Promise<() => void>;
  observe?: (changed: () => void) => Promise<() => void>;
  git?: (args: string[]) => Promise<GitResult>;
};

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

export default class WorkbenchInstallationUpdateController {
  private value: InstallationUpdate = {
    state: "unavailable", reason: "not checked", upstream: null, behind: 0, ahead: 0,
    conflicts: [], lockfileChanged: false, checkedAt: null, projectId: null, failure: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly journalPath: string;
  private readonly git: (args: string[]) => Promise<GitResult>;
  private readonly integration: WorkbenchGitIntegration;
  private stopSchedule: (() => void) | null = null;
  private stopWatch: (() => void) | null = null;
  private closed = false;
  private background: Promise<void> | null = null;
  private pendingCheck: boolean | null = null;
  private fetchFailure: string | null = null;

  constructor(private readonly options: Options) {
    this.journalPath = path.join(options.dataRoot ?? resolveWorkbenchDataRoot(), ...INSTALLATION_REPAIR_JOURNAL_SEGMENTS);
    this.integration = new WorkbenchGitIntegration(new WorkbenchGitRepository(options.repoRoot));
    this.git = options.git ?? (args => new Promise((resolve, reject) => {
      execFile("git", args, {
        cwd: options.repoRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      });
    }));
  }

  read() { return this.value; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  start() {
    if (this.closed || this.stopSchedule) return;
    const schedule = this.options.schedule ?? (check => {
      const timer = setInterval(check, 15 * 60 * 1000);
      timer.unref();
      return () => clearInterval(timer);
    });
    this.stopSchedule = schedule(() => this.backgroundCheck(true));
    this.backgroundCheck(true, true);
  }

  async dispose() {
    this.closed = true;
    this.stopSchedule?.();
    this.stopWatch?.();
    this.listeners.clear();
    await this.background;
  }

  private backgroundCheck(fetch: boolean, initialize = false) {
    if (this.closed) return;
    if (this.background) { this.pendingCheck = (this.pendingCheck ?? false) || fetch; return; }
    const work = (async () => {
      if (initialize) await this.initializeWatch();
      if (!this.closed) await this.check(fetch);
      while (this.pendingCheck !== null && !this.closed) {
        const fetch = this.pendingCheck;
        this.pendingCheck = null;
        await this.check(fetch);
      }
    })();
    this.background = work;
    void work.then(() => { this.background = null; }, error => {
      this.background = null;
      this.options.warn(`Installation update scheduling failed: ${message(error)}`);
    });
  }

  private async initializeWatch() {
    const stops: Array<() => void> = [];
    const changed = () => this.backgroundCheck(false);
    try {
      if (this.options.watch) stops.push(await this.options.watch(changed));
      else {
        const gitDir = path.resolve(this.options.repoRoot, (await this.required(["rev-parse", "--git-dir"])).trim());
        const commonDir = path.resolve(this.options.repoRoot, (await this.required(["rev-parse", "--git-common-dir"])).trim());
        stops.push(await watchGitRefs({ gitDir, commonDir }, ["heads"], changed,
          error => this.options.warn(`Installation update watcher failed: ${message(error)}`)));
      }
    } catch (error) {
      this.options.warn(`Installation update watcher unavailable: ${message(error)}`);
    }
    try {
      if (this.options.observe) stops.push(await this.options.observe(changed));
    } catch (error) {
      this.options.warn(`Installation project observation unavailable: ${message(error)}`);
    }
    const stop = () => { for (const stop of stops) stop(); };
    if (this.closed) stop();
    else this.stopWatch = stop;
  }

  async check(fetch = true) {
    // Fetching only writes remote-tracking refs, never HEAD or the worktree, so a slow network must not hold the
    // worktree transition lease that arc operations wait on.
    const hasUpstream = async () => (await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).code === 0;
    if (fetch && await hasUpstream()) {
      try {
        const result = await this.git(["fetch"]);
        // Git stderr can echo remote URLs with embedded credentials, so it never leaves this process.
        if (result.code) throw new Error(`Could not fetch the running checkout's upstream (git exit ${result.code}).`);
        this.fetchFailure = null;
      } catch (error) {
        const reason = message(error);
        if (reason !== this.fetchFailure) this.options.warn(`Installation update check failed: ${reason}`);
        this.fetchFailure = reason;
      }
    }
    const inspect = async () => {
      try {
        const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        if (upstream.code) {
          // Missing upstream is expected; other Git failures must remain visible.
          const branch = await this.git(["rev-parse", "--is-inside-work-tree"]);
          if (branch.code) throw new Error("Running checkout is not a Git worktree.");
          this.fetchFailure = null;
          this.publish({ ...this.value, state: "unavailable", reason: "no upstream", upstream: null,
            ahead: 0, behind: 0, conflicts: [], lockfileChanged: false, checkedAt: Date.now(),
            projectId: await this.options.projectId(), failure: (await this.readJournal())?.failure ?? null });
          return this.value;
        }
        await this.recompute();
      } catch (error) {
        const reason = message(error);
        if (reason !== this.fetchFailure) this.options.warn(`Installation update check failed: ${reason}`);
        this.fetchFailure = reason;
        this.publish({ ...this.value, state: "unavailable", reason, checkedAt: Date.now() });
      }
      return this.value;
    };
    return this.options.transitions.read(this.options.repoRoot, inspect);
  }

  private async required(args: string[]) {
    const result = await this.git(args);
    if (result.code) throw new Error(`Installation Git ${args[0]} failed.`);
    return result.stdout;
  }

  /** Predict the upstream integration in memory and publish it; returns the plan a pull applies. */
  private async recompute() {
    const upstream = (await this.required(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim().slice(0, 256);
    const incoming = (await this.required(["rev-parse", "@{u}"])).trim();
    const plan = await this.integration.prepare(incoming);
    const conflicts = plan.kind === "blocked" ? plan.conflicts : [];
    const state = this.fetchFailure ? "unavailable"
      : plan.kind === "current" ? "current" : plan.kind === "blocked" ? "conflict" : "available";
    this.publish({
      state, reason: this.fetchFailure ?? (plan.kind === "blocked" ? plan.reason : null), upstream,
      ahead: plan.ahead, behind: plan.behind,
      conflicts: conflicts.slice(0, INSTALLATION_UPDATE_MAX_CONFLICTS),
      lockfileChanged: plan.incomingPaths.includes("pnpm-lock.yaml"), checkedAt: Date.now(),
      projectId: await this.options.projectId(), failure: (await this.readJournal())?.failure ?? null,
    });
    return plan;
  }

  async pull(): Promise<InstallationPullResult> {
    return this.options.transitions.run(this.options.repoRoot, async () => {
      const plan = await this.recompute();
      if (this.value.state !== "available") throw new Error("Installation update is not available for a clean pull.");
      const { fromSha, toSha, warnings } = await this.integration.apply(plan);
      for (const warning of warnings) this.options.warn(`Installation pull: ${message(warning)}`);
      await this.recompute();
      return { fromSha, toSha, lockfileChanged: plan.incomingPaths.includes("pnpm-lock.yaml") };
    });
  }

  private async readJournal(): Promise<InstallationRepairJournal | null> {
    let text: string;
    try { text = await fs.readFile(this.journalPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try { return InstallationRepairJournalSchema.parse(JSON.parse(text)); }
    catch { this.options.warn("Installation repair journal is invalid; ignoring it."); return null; }
  }

  async dismissFailure() {
    return this.options.transitions.run(this.options.repoRoot, async () => {
      const journal = await this.readJournal();
      if (journal && journal.phase !== "done") throw new Error("Installation repair is not complete.");
      if (journal?.failure) {
        const temporary = `${this.journalPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ ...journal, failure: null, updatedAt: Date.now() }));
        await fs.rename(temporary, this.journalPath);
      }
      this.publish({ ...this.value, failure: null });
      return { ok: true as const };
    });
  }

  private publish(value: InstallationUpdate) {
    if (this.closed) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}
