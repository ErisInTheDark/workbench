/*
 * Exports:
 * - default WorkbenchInstallationUpdateController: own running-checkout fetches, upstream prediction and leased pulls through
 *   WorkbenchGitIntegration, repair failure and selected-project-aware background checks.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import {
  INSTALLATION_REPAIR_JOURNAL_SEGMENTS, INSTALLATION_UPDATE_MAX_CONFLICTS,
  InstallationRepairJournalSchema, InstallationUpdateFailureSchema,
  type InstallationUpdateFailure, type InstallationPullResult,
} from "workbench-shared/workbench/installation-update";
import {
  INSTALLATION_UPDATE_MAX_INCOMING_PATHS,
  type InstallationPullOptions, type PredictedInstallationUpdate as InstallationUpdate,
} from "workbench-shared/workbench/installation-update-prediction";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type { ProjectId } from "workbench-shared/workbench/identity";
import type { ReloadDirtScope } from "workbench-shared/reload/reload-dirt-scope";
import WorkbenchGitIntegration, { type WorkbenchGitIntegrationPlan } from "../lib/workbench/git/WorkbenchGitIntegration";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import watchGitRefs from "../lib/workbench/git/git-ref-watch";
import type { createWorktreeGitTransitions } from "../git/worktree-git-transitions";

type GitResult = { code: number; stdout: string; stderr: string };
/** The upstream integration a check read under the worktree lease; `null` when the checkout has no upstream. */
type Inspection = { upstream: string; incoming: string; plan: WorkbenchGitIntegrationPlan } | null;
const journalSource = z.record(z.string(), z.json());
const journalView = InstallationRepairJournalSchema.omit({ failure: true }).partial();
const journalControl = InstallationRepairJournalSchema.pick({ version: true, id: true, phase: true }).strip();
type JournalRead = {
  source: z.infer<typeof journalSource> | null;
  failure: InstallationUpdateFailure | null;
  canDismiss: boolean;
};
type Options = {
  repoRoot: string;
  dataRoot?: string;
  transitions: Pick<ReturnType<typeof createWorktreeGitTransitions>, "run" | "read">;
  projectId(): Promise<ProjectId | null>;
  warn(message: string): void;
  schedule?: (check: () => void, intervalMs: number) => () => void;
  watch?: (changed: () => void) => (() => void) | Promise<() => void>;
  observe?: (changed: () => void) => Promise<() => void>;
  /** The daemon scopes `incomingPaths` would dirty once `target` is checked out. */
  predict?: (incomingPaths: readonly string[], target: string, signal: AbortSignal) => Promise<ReloadDirtScope[]>;
  /** Runs one git command; `signal` aborts it when the controller is disposed. */
  git?: (args: string[], signal: AbortSignal) => Promise<GitResult>;
};

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

export default class WorkbenchInstallationUpdateController {
  private value: InstallationUpdate = {
    state: "unavailable", reason: "not checked", upstream: null, behind: 0, ahead: 0,
    conflicts: [], lockfileChanged: false, incomingPaths: null, predictedScopes: null,
    checkedAt: null, projectId: null, failure: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly journalPath: string;
  private readonly git: (args: string[]) => Promise<GitResult>;
  private readonly integration: WorkbenchGitIntegration;
  private schedule: { intervalMs: number; stop(): void } | null = null;
  private readonly projectDemand = new Set<(projectId: ProjectId) => boolean>();
  private stopWatch: (() => void) | null = null;
  private closed = false;
  private background: Promise<void> | null = null;
  private pendingCheck: boolean | null = null;
  private fetchFailure: string | null = null;
  /** Aborted on dispose, so a hung fetch can never hold a reload open. */
  private readonly lifetime = new AbortController();

  constructor(private readonly options: Options) {
    this.journalPath = path.join(options.dataRoot ?? resolveWorkbenchDataRoot(), ...INSTALLATION_REPAIR_JOURNAL_SEGMENTS);
    this.integration = new WorkbenchGitIntegration(new WorkbenchGitRepository(options.repoRoot));
    const git = options.git ?? ((args: string[], signal: AbortSignal) => new Promise<GitResult>((resolve, reject) => {
      execFile("git", args, {
        cwd: options.repoRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      });
    }));
    this.git = args => git(args, this.lifetime.signal);
  }

  read() { return this.value; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  start() {
    if (this.closed || this.schedule) return;
    this.scheduleChecks();
    this.backgroundCheck(true, true);
  }

  trackProjectDemand(read: (projectId: ProjectId) => boolean) {
    if (this.closed) throw new Error("Installation update checks were disposed.");
    const demand = (projectId: ProjectId) => read(projectId);
    this.projectDemand.add(demand);
    this.refreshSchedule();
    return {
      refresh: () => { if (this.projectDemand.has(demand)) this.refreshSchedule(); },
      release: () => {
        if (this.projectDemand.delete(demand)) this.refreshSchedule();
      },
    };
  }

  private checkInterval() {
    const id = this.value.projectId;
    return id && [...this.projectDemand].some(read => read(id)) ? 30_000 : 15 * 60 * 1000;
  }

  private refreshSchedule() {
    if (this.closed || !this.schedule || this.schedule.intervalMs === this.checkInterval()) return;
    this.schedule.stop();
    this.scheduleChecks();
  }

  private scheduleChecks() {
    const intervalMs = this.checkInterval();
    const schedule = this.options.schedule ?? ((check, interval) => {
      const timer = setInterval(check, interval);
      timer.unref();
      return () => clearInterval(timer);
    });
    this.schedule = { intervalMs, stop: schedule(() => this.backgroundCheck(true), intervalMs) };
  }

  async dispose() {
    this.closed = true;
    this.lifetime.abort(new Error("Installation update checks were disposed."));
    this.schedule?.stop();
    this.schedule = null;
    this.projectDemand.clear();
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
    try {
      // The lease covers Git reads only: catalogue, prediction and journal reads await other owners' work.
      await this.publishInspection(await this.options.transitions.read(this.options.repoRoot, () => this.inspect()));
    } catch (error) {
      if (this.closed) return this.value;
      const reason = message(error);
      if (reason !== this.fetchFailure) this.options.warn(`Installation update check failed: ${reason}`);
      this.fetchFailure = reason;
      this.publish({ ...this.value, state: "unavailable", reason, checkedAt: Date.now() });
    }
    return this.value;
  }

  private async required(args: string[]) {
    const result = await this.git(args);
    if (result.code) throw new Error(`Installation Git ${args[0]} failed.`);
    return result.stdout;
  }

  /** Reads the running checkout's upstream integration; callers hold the worktree lease. */
  private async inspect(): Promise<Inspection> {
    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.code) {
      // Missing upstream is expected; other Git failures must remain visible.
      const branch = await this.git(["rev-parse", "--is-inside-work-tree"]);
      if (branch.code) throw new Error("Running checkout is not a Git worktree.");
      return null;
    }
    const incoming = (await this.required(["rev-parse", "@{u}"])).trim();
    return { upstream: upstream.stdout.trim().slice(0, 256), incoming, plan: await this.integration.prepare(incoming) };
  }

  private updateState(plan: WorkbenchGitIntegrationPlan) {
    return this.fetchFailure ? "unavailable"
      : plan.kind === "current" ? "current" : plan.kind === "blocked" ? "conflict" : "available";
  }

  /** Publishes an inspection with its project, predicted reload impact and repair failure; runs outside the lease. */
  private async publishInspection(inspection: Inspection) {
    const projectId = await this.untilDisposed(this.options.projectId());
    const failure = (await this.untilDisposed(this.readJournal()))?.failure ?? null;
    if (!inspection) {
      this.fetchFailure = null;
      this.publish({ ...this.value, state: "unavailable", reason: "no upstream", upstream: null,
        ahead: 0, behind: 0, conflicts: [], lockfileChanged: false, incomingPaths: null, predictedScopes: null,
        checkedAt: Date.now(), projectId, failure });
      return;
    }
    const { upstream, incoming, plan } = inspection;
    const incomingPaths = plan.incomingPaths.length <= INSTALLATION_UPDATE_MAX_INCOMING_PATHS ? plan.incomingPaths : null;
    this.publish({
      state: this.updateState(plan), reason: this.fetchFailure ?? (plan.kind === "blocked" ? plan.reason : null), upstream,
      ahead: plan.ahead, behind: plan.behind,
      conflicts: (plan.kind === "blocked" ? plan.conflicts : []).slice(0, INSTALLATION_UPDATE_MAX_CONFLICTS),
      lockfileChanged: plan.incomingPaths.includes("pnpm-lock.yaml"),
      incomingPaths, predictedScopes: await this.untilDisposed(this.predict(incomingPaths, incoming)),
      checkedAt: Date.now(), projectId, failure,
    });
  }

  /** Disposal must not wait on other owners' work, so it abandons whatever is still pending. */
  private untilDisposed<T>(work: Promise<T>) {
    const signal = this.lifetime.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  /** A failed prediction degrades to unknown impact; it never blocks the update itself. */
  private async predict(incomingPaths: readonly string[] | null, target: string) {
    if (!incomingPaths || !this.options.predict) return null;
    if (!incomingPaths.length) return [];
    try {
      return await this.options.predict(incomingPaths, target, this.lifetime.signal);
    } catch (error) {
      if (this.lifetime.signal.aborted) throw error;
      this.options.warn(`Installation update prediction failed: ${message(error)}`);
      return null;
    }
  }

  async pull({ withoutInstall = false }: InstallationPullOptions = {}): Promise<InstallationPullResult> {
    const leased = await this.options.transitions.run(this.options.repoRoot, async () => {
      const before = await this.inspect();
      const refusal = !before || this.updateState(before.plan) !== "available"
        ? "Installation update is not available for a clean pull."
        : withoutInstall && before.plan.incomingPaths.includes("pnpm-lock.yaml")
          ? "Dependencies changed; update from that device." : null;
      if (!before || refusal) return { inspection: before, refusal, result: null };
      const { fromSha, toSha, warnings } = await this.integration.apply(before.plan);
      for (const warning of warnings) this.options.warn(`Installation pull: ${message(warning)}`);
      const result = { fromSha, toSha, lockfileChanged: before.plan.incomingPaths.includes("pnpm-lock.yaml") };
      return { inspection: await this.inspect(), refusal: null, result };
    });
    await this.publishInspection(leased.inspection);
    if (!leased.result) throw new Error(leased.refusal ?? "Installation update is not available for a clean pull.");
    return leased.result;
  }

  private async readJournal(): Promise<JournalRead | null> {
    let text: string;
    try { text = await fs.readFile(this.journalPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const unknownFailure: InstallationUpdateFailure = {
      at: Date.now(), logPath: "", message: "Installation repair journal needs attention.",
    };
    let decoded: unknown;
    try { decoded = JSON.parse(text); }
    catch {
      this.options.warn("Installation repair journal contains malformed JSON.");
      return { source: null, failure: unknownFailure, canDismiss: false };
    }
    const source = conformToZodSchema(journalSource, decoded);
    if (!source.success) {
      this.options.warn("Installation repair journal is not an object.");
      return { source: null, failure: unknownFailure, canDismiss: false };
    }
    const { failure: storedFailure, ...fields } = source.data;
    const view = conformToZodSchema(journalView, fields);
    const control = conformToZodSchema(journalControl, source.data);
    const fallback = { ...unknownFailure,
      at: view.success ? view.data.updatedAt ?? view.data.createdAt ?? unknownFailure.at : unknownFailure.at,
      logPath: view.success ? view.data.logPath ?? "" : "",
    };
    const failure = storedFailure === null ? null
      : conformToZodSchema(InstallationUpdateFailureSchema, storedFailure, fallback);
    const repairedPaths = [...view.repairedPaths, ...control.repairedPaths,
      ...(failure?.repairedPaths.map(path => ["failure", ...path]) ?? [])];
    if (repairedPaths.length) {
      const paths = repairedPaths.slice(0, 5).map(path => path.map(String).join(".") || "<root>").join(", ")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 512);
      this.options.warn(`Installation repair journal repaired: ${paths}`);
    }
    return {
      source: source.data,
      failure: failure?.data ?? (control.success && view.success ? null : fallback),
      canDismiss: control.success && control.data.phase === "done",
    };
  }

  async dismissFailure() {
    return this.options.transitions.run(this.options.repoRoot, async () => {
      const journal = await this.readJournal();
      if (journal && !journal.canDismiss) throw new Error("Installation repair is not complete or its journal identity is invalid.");
      if (journal?.failure) {
        const temporary = `${this.journalPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ ...journal.source, failure: null, updatedAt: Date.now() }));
        await fs.rename(temporary, this.journalPath);
      }
      this.publish({ ...this.value, failure: null });
      return { ok: true as const };
    });
  }

  private publish(value: InstallationUpdate) {
    if (this.closed) return;
    this.value = value;
    this.refreshSchedule();
    for (const listener of this.listeners) listener();
  }
}
