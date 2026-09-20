/*
 * Exports:
 * - IsolatedWorkbenchOptions: select optional external identities shared with an isolated runtime.
 * - IsolatedWorkbenchSignalCleanup: settle registered scenario cleanup before a signalled test process exits.
 * - default IsolatedWorkbench: boot current source with private storage and own its socket/process cleanup.
 * - removeIsolatedWorkbenchWorkspace: clean one validated stopped workspace.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createSpawnOptions, killProcessTreeAsync } from "../../daemon/server/process-helpers";
import WorkbenchSocketClient from "../../shared/workbench/WorkbenchSocketClient";
import { isWorkbenchRpcFailure } from "../../shared/workbench/workbench-rpc";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "../../shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchTranscriptClient from "../../app/client/workbench/database/transcript/WorkbenchTranscriptClient";
import type { WorkbenchComposerProfile } from "../../shared/types";
import { WorkbenchDaemonReadySchema, type WorkbenchDaemonEndpoint } from "../../shared/http/workbench-daemon-endpoint";

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; workbenchEventStreamSequence?: number };

export interface IsolatedWorkbenchOptions {
  codexIdentity?: boolean;
  openCodeIdentity?: {
    configDirectory: string;
    database: string;
  };
  stateHome?: string;
}

interface IsolatedWorkbenchSignalTarget {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

type IsolatedWorkbenchCleanup = () => Promise<void>;

export class IsolatedWorkbenchSignalCleanup {
  private readonly cleanups = new Set<IsolatedWorkbenchCleanup>();
  private attached = false;
  private handling = false;
  private readonly interrupt = () => { void this.handle("SIGINT"); };
  private readonly terminate = () => { void this.handle("SIGTERM"); };

  constructor(
    private readonly target: IsolatedWorkbenchSignalTarget,
    private readonly exit: (code: number) => void,
    private readonly report: (error: unknown) => void = error => console.error("Isolated scenario signal cleanup failed", error),
  ) {}

  register(cleanup: IsolatedWorkbenchCleanup) {
    this.cleanups.add(cleanup);
    this.attach();
    return () => {
      this.cleanups.delete(cleanup);
      if (this.cleanups.size === 0) this.detach();
    };
  }

  private attach() {
    if (this.attached) return;
    this.attached = true;
    this.target.on("SIGINT", this.interrupt);
    this.target.on("SIGTERM", this.terminate);
  }

  private detach() {
    if (!this.attached) return;
    this.attached = false;
    this.target.off("SIGINT", this.interrupt);
    this.target.off("SIGTERM", this.terminate);
  }

  private async handle(signal: "SIGINT" | "SIGTERM") {
    if (this.handling) return;
    this.handling = true;
    this.detach();
    const cleanups = [...this.cleanups];
    this.cleanups.clear();
    const results = await Promise.allSettled(cleanups.map(async cleanup => await cleanup()));
    for (const result of results) {
      if (result.status === "rejected") this.report(result.reason);
    }
    this.exit(signal === "SIGINT" ? 130 : 143);
  }
}

const isolatedWorkbenchSignalCleanup = new IsolatedWorkbenchSignalCleanup(
  process,
  code => process.exit(code),
);

function validateWorkspace(fixtures: string, root: string) {
  const resolvedFixtures = path.resolve(fixtures);
  const resolvedRoot = path.resolve(root);
  assert.equal(path.dirname(resolvedRoot), resolvedFixtures, "Scenario workspace must be a direct child of its fixture root");
  assert.match(path.basename(resolvedRoot), /^wb-scenario-/u, "Scenario workspace must have an owned prefix");
  return resolvedRoot;
}

async function removeIsolatedWorkbenchIdentity(fixtures: string, root: string, codexIdentity: boolean) {
  root = validateWorkspace(fixtures, root);
  await fs.rm(path.join(root, "codex", "auth.json"), { force: true });
  if (codexIdentity && process.platform === "win32") {
    await fs.rm(path.join(root, "codex", ".sandbox-secrets"), { force: true });
    await fs.rm(path.join(root, "codex", ".sandbox", "setup_marker.json"), { force: true });
  }
  return root;
}

export async function removeIsolatedWorkbenchWorkspace(fixtures: string, root: string, codexIdentity: boolean) {
  root = await removeIsolatedWorkbenchIdentity(fixtures, root, codexIdentity);
  await fs.rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
}

export default class IsolatedWorkbench {
  readonly events: Message[] = [];
  private readonly observers = new Set<() => void>();
  private child: ChildProcess | null = null;
  private appChild: ChildProcess | null = null;
  private appLog = "";
  private appAddress: string | null = null;
  private client: WorkbenchSocketClient | null = null;
  readonly daemon = new WorkbenchDaemonClient({ request: (method, params) => this.request(method, params) });
  private transcriptClient: WorkbenchTranscriptClient | null = null;
  private log = "";
  private closed = false;
  private endpoint: WorkbenchDaemonEndpoint | null = null;
  private releaseSignalCleanup: (() => void) | null = null;
  private constructor(
    private readonly fixtures: string,
    readonly root: string,
    readonly project: string,
    readonly dataRootPath: string,
    readonly signal: AbortSignal,
    private readonly codexIdentity: boolean,
    private readonly openCodeIdentity: IsolatedWorkbenchOptions["openCodeIdentity"],
    private readonly stateHome: string | null,
  ) {}

  get processIds() { return { daemon: this.child?.pid, app: this.appChild?.pid }; }
  get output() { return this.log; }
  get appOutput() { return this.appLog; }
  get appOrigin() {
    assert.ok(this.appAddress, "Isolated app must be listening");
    return this.appAddress;
  }

  async waitForAppExit() {
    assert.ok(this.appChild, "Scenario app must have been started");
    const child = this.appChild;
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit", { signal: this.signal });
    }
    return child.exitCode;
  }

  get transcripts() {
    assert.ok(this.transcriptClient, "Scenario transcript client must be connected");
    return this.transcriptClient;
  }
  get daemonEndpoint() {
    assert.ok(this.endpoint, "Isolated daemon must have published readiness");
    return this.endpoint;
  }
  get origin() { return this.daemonEndpoint.origin; }

  static async create(source: string, signal: AbortSignal, options: IsolatedWorkbenchOptions = {}) {
    const fixtures = path.join(source, ".workbench", "test-runs");
    await fs.mkdir(fixtures, { recursive: true });
    const root = await fs.mkdtemp(path.join(fixtures, "wb-scenario-"));
    const codexIdentity = options.codexIdentity ?? true;
    try {
      return await this.initialise(
        source,
        fixtures,
        root,
        signal,
        codexIdentity,
        options.openCodeIdentity,
        options.stateHome ?? null,
      );
    } catch (error) {
      try {
        await removeIsolatedWorkbenchWorkspace(fixtures, root, codexIdentity);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Scenario setup and cleanup failed; retained workspace: ${root}`);
      }
      throw error;
    }
  }

  private static async initialise(
    source: string,
    fixtures: string,
    root: string,
    signal: AbortSignal,
    codexIdentity: boolean,
    openCodeIdentity: IsolatedWorkbenchOptions["openCodeIdentity"],
    stateHome: string | null,
  ) {
    const project = path.join(root, "projects", "fixture");
    await fs.mkdir(project, { recursive: true });
    const ignored = new Set(["node_modules", ".workbench", ".git", ".next", "dist", "target", ".env.local"]);
    for (const directory of ["app", "daemon", "shared", "instructions", "package"]) {
      await fs.cp(path.join(source, directory), path.join(project, directory), {
        recursive: true, filter: (file) => !ignored.has(path.basename(file)),
      });
    }
    await fs.copyFile(path.join(source, "package.json"), path.join(project, "package.json"));
    await fs.copyFile(path.join(source, ".gitignore"), path.join(project, ".gitignore"));
    await fs.mkdir(path.join(project, ".workbench"), { recursive: true });
    await fs.copyFile(path.join(source, "test/scenarios/isolated-shutdown.mjs"), path.join(project, ".workbench/isolated-shutdown.mjs"));
    await fs.symlink(path.join(source, "node_modules"), path.join(project, "node_modules"), "junction");
    for (const directory of ["daemon", "app", "shared"]) {
      const dependencies = path.join(source, directory, "node_modules");
      await fs.mkdir(path.join(project, directory, "node_modules"), { recursive: true });
      for (const entry of await fs.readdir(dependencies, { withFileTypes: true })) {
        if (entry.name === ".bin") continue;
        const target = entry.name === "workbench-shared" ? path.join(project, "shared") : path.join(dependencies, entry.name);
        await fs.symlink(target, path.join(project, directory, "node_modules", entry.name), "junction");
      }
    }
    // Only this newly allocated fixture receives Git writes. No workspace arc
    // tool can initialise an unregistered, empty test repository.
    await this.command("git", ["init", "-q"], project, process.env, signal);
    await this.command("git", ["config", "user.name", "Workbench scenario"], project, process.env, signal);
    await this.command("git", ["config", "user.email", "scenario@localhost"], project, process.env, signal);
    await this.command("git", ["-c", "user.name=Workbench scenario", "-c", "user.email=scenario@localhost",
      "commit", "--allow-empty", "-qm", "isolated scenario fixture"], project, process.env, signal);
    if (codexIdentity && process.platform === "win32") {
      // Convex-lab's sharing boundary: reuse the existing Windows identity, not
      // its sessions or the whole .sandbox directory. Never initialise another.
      const main = path.join(os.homedir(), ".codex");
      const secrets = path.join(main, ".sandbox-secrets");
      const marker = path.join(main, ".sandbox", "setup_marker.json");
      assert.ok((await fs.stat(secrets)).isDirectory(), "Main Codex sandbox identity must exist");
      assert.ok((await fs.stat(marker)).isFile(), "Main Codex sandbox setup must be complete");
      const home = path.join(root, "codex");
      await fs.mkdir(path.join(home, ".sandbox"), { recursive: true });
      await fs.symlink(secrets, path.join(home, ".sandbox-secrets"), "dir");
      try {
        await fs.link(marker, path.join(home, ".sandbox", "setup_marker.json"));
      } catch (error) {
        await fs.unlink(path.join(home, ".sandbox-secrets"));
        throw error;
      }
    }
    return new IsolatedWorkbench(
      fixtures,
      root,
      project,
      path.join(root, "data", "inthedark", "wb"),
      signal,
      codexIdentity,
      openCodeIdentity,
      stateHome,
    );
  }

  async start(profiles: readonly WorkbenchComposerProfile[] = [], prefixProof = "lifecycle") {
    this.closed = false;
    this.endpoint = null;
    this.releaseSignalCleanup ??= isolatedWorkbenchSignalCleanup.register(async () => {
      await this.stopForSignal();
    });
    const home = path.join(this.root, "codex");
    const library = path.join(this.root, "library");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(library, { recursive: true });
    await fs.mkdir(path.join(this.root, "user"), { recursive: true });
    await fs.writeFile(path.join(this.project, "AGENTS.md"), `The scenario passphrase is "${prefixProof}". When asked for the prefix proof, quote this passphrase exactly in commentary. Do not edit files or start other agents.\n`);
    const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    if (this.codexIdentity) await fs.copyFile(path.join(originalHome, "auth.json"), path.join(home, "auth.json"));
    await fs.writeFile(path.join(home, "config.toml"), 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n'
      + (this.codexIdentity && process.platform === "win32" ? '[windows]\nsandbox = "elevated"\n' : ""));
    const env = this.environment();
    const child = spawn(process.execPath, ["--import", "tsx", "--import",
      pathToFileURL(path.join(this.project, ".workbench/isolated-shutdown.mjs")).href, "server/index.ts"], {
      ...createSpawnOptions(path.join(this.project, "daemon"), env, true),
      windowsVerbatimArguments: false, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    const collect = (chunk: Buffer) => {
      this.log += chunk.toString();
      appendFileSync(path.join(this.root, "daemon.log"), chunk);
      for (const observer of this.observers) observer();
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    let readinessError: Error | null = null;
    child.on("message", message => {
      const ready = WorkbenchDaemonReadySchema.safeParse(message);
      if (!ready.success || ready.data.endpoint.pid !== child.pid) {
        readinessError = new Error("Isolated daemon sent an invalid ready message");
      } else this.endpoint = ready.data.endpoint;
      for (const observer of this.observers) observer();
    });
    child.once("exit", () => { for (const observer of this.observers) observer(); });
    await this.until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated daemon exited ${child.exitCode}\n${this.log.slice(-12000)}`);
      if (readinessError) throw readinessError;
      return this.endpoint !== null;
    });
    const client = new WorkbenchSocketClient();
    this.client = client;
    this.transcriptClient = new WorkbenchTranscriptClient({
      transport: {
        onDisconnect: (listener) => client.onConnectionClose(listener),
        onNotification: (listener) => client.onWorkbenchNotification(listener),
        request: (method, params) => this.request(method, params),
      },
      reportConformance: (report) => console.error("Scenario transcript conformance failure", report),
    });
    client.onNotification((message) => {
      this.events.push(message as Message);
      for (const observer of this.observers) observer();
    });
    client.onWorkbenchNotification((message) => {
      this.events.push(message as Message);
      for (const observer of this.observers) observer();
    });
    let stopAvailability = () => {};
    const ready = new Promise<void>(resolve => {
      stopAvailability = this.transcripts.onAvailabilityChange(available => { if (available) resolve(); });
    });
    try {
      await this.withSignal(client.connect(this.origin.replace("http:", "ws:")), this.signal);
      // The daemon announces capabilities on the first WB request, not socket open.
      await this.daemon.projects.catalog();
      await this.withSignal(ready, this.signal);
      for (const profile of profiles) await this.daemon.profiles.upsert({ profile });
    } finally {
      stopAvailability();
    }
  }

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env, CODEX_HOME: path.join(this.root, "codex"), WORKBENCH_LIBRARY_ROOT: path.join(this.root, "library"),
      HOME: path.join(this.root, "user"), USERPROFILE: path.join(this.root, "user"),
      WORKBENCH_DATA_ROOT: this.dataRootPath,
      WORKBENCH_PROJECTS_ROOT: path.dirname(this.project),
      WORKBENCH_DAEMON_LOOP: "1",
      WORKBENCH_TEMPORARY_ROOT: path.join(this.project, ".workbench", "tmp"),
      TSX_TSCONFIG_PATH: path.join(this.project, "daemon", "tsconfig.json"),
      XDG_DATA_HOME: path.join(this.root, "data"), XDG_CONFIG_HOME: path.join(this.root, "config"),
      XDG_CACHE_HOME: path.join(this.root, "cache"), NO_COLOR: "1",
      ...(this.openCodeIdentity ? {
        OPENCODE_CONFIG_DIR: this.openCodeIdentity.configDirectory,
        OPENCODE_DB: this.openCodeIdentity.database,
      } : {}),
      ...(this.stateHome === null ? {} : { XDG_STATE_HOME: this.stateHome }),
    };
    // These children represent a separate installation, never the agent's live caller.
    for (const key of ["WORKBENCH_THREAD_ID", "CODEX_THREAD_ID", "WORKBENCH_DESKTOP_PROTOCOL", "WORKBENCH_APP_PORT",
      "CODEX_APP_SERVER_URL", "WORKBENCH_CODEX_APP_SERVER_URL", "WORKBENCH_CODEX_APP_SERVER_PORT"]) delete env[key];
    env.WORKBENCH_APP_HOST = "127.0.0.1";
    return env;
  }

  async startApp() {
    assert.equal(this.appChild, null);
    const offset = this.appLog.length;
    const child = spawn(process.execPath, ["--import", "tsx", "--import",
      pathToFileURL(path.join(this.project, ".workbench/isolated-shutdown.mjs")).href, "app/server/index.ts"], {
      ...createSpawnOptions(this.project, { ...this.environment(), TSX_TSCONFIG_PATH: path.join(this.project, "app/tsconfig.json") }, true),
      windowsVerbatimArguments: false, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    this.appChild = child;
    const collect = (chunk: Buffer) => {
      this.appLog += chunk.toString();
      appendFileSync(path.join(this.root, "app.log"), chunk);
      for (const observer of this.observers) observer();
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.once("exit", () => { for (const observer of this.observers) observer(); });
    await this.until(() => {
      const output = this.appLog.slice(offset);
      if (child.exitCode !== null || child.signalCode !== null || output.includes("failed to start:")) {
        throw new Error(`Isolated app failed\n${output.slice(-12000)}`);
      }
      const match = output.match(/listening at (http:\/\/[^\s]+)/u);
      if (!match) return false;
      this.appAddress = match[1];
      return true;
    });
  }

  async request<T = unknown>(method: string, params: unknown = {}, fields: object = {}, signal = this.signal): Promise<T> {
    if (this.closed || !this.client) throw new Error("Isolated runtime is not connected");
    signal.throwIfAborted();
    const response = await this.withSignal(this.client.sendRequest<T>({ method, params, ...fields }), signal);
    if (isWorkbenchRpcFailure(response)) throw new WorkbenchDaemonRequestError(response.error.message, response.error.code);
    return response.result;
  }

  private async withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  until(predicate: () => boolean, signal = this.signal) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.observers.delete(check);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const check = () => { try { if (predicate()) finish(); } catch (error) { finish(error); } };
      const abort = () => finish(signal.reason);
      this.observers.add(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }

  async stop() {
    return await this.stopOwnedProcesses(false);
  }

  private async stopForSignal() {
    await this.stopOwnedProcesses(true);
  }

  private async stopOwnedProcesses(force: boolean) {
    this.closed = true;
    this.releaseSignalCleanup?.();
    this.releaseSignalCleanup = null;
    this.transcriptClient?.dispose();
    this.transcriptClient = null;
    this.client?.dispose();
    this.client = null;
    const children = { app: this.appChild, daemon: this.child };
    const results = await Promise.allSettled([
      this.child ? this.stopChild(this.child, force).then(() => { this.child = null; }) : Promise.resolve(),
      this.appChild ? this.stopChild(this.appChild, force).then(() => { this.appChild = null; this.appAddress = null; }) : Promise.resolve(),
    ]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Isolated process cleanup failed");
    return { app: children.app?.exitCode, daemon: children.daemon?.exitCode };
  }

  private async stopChild(child: ChildProcess, force: boolean) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (force) {
          await killProcessTreeAsync(child.pid);
          return;
        }
        const signal = AbortSignal.timeout(45_000);
        const exited = once(child, "exit", { signal }).then(
          () => null,
          (error: Error) => error,
        );
        const sendError = child.connected
          ? await new Promise<Error | null>((resolve) => {
            child.send({ type: "workbench-scenario-close" }, error => resolve(error ?? null));
          })
          : new Error("Scenario shutdown channel disconnected before exit");
        const exitError = await exited;
        // A failed startup can close IPC before its exit event reaches us.
        // Confirmed exit completes cleanup; otherwise retain both failures.
        if (exitError) throw sendError
          ? new AggregateError([sendError, exitError], "Scenario shutdown did not complete")
          : exitError;
      }
    } finally {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }

  async close() {
    try {
      await this.stop();
    } catch (error) {
      try {
        await removeIsolatedWorkbenchIdentity(this.fixtures, this.root, this.codexIdentity);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Scenario shutdown failed; retained workspace: ${this.root}`);
      }
      throw new AggregateError([error], `Scenario shutdown failed; retained workspace: ${this.root}`);
    }
    await removeIsolatedWorkbenchWorkspace(this.fixtures, this.root, this.codexIdentity);
  }

  static async command(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const [code] = await once(child, "exit", { signal });
    assert.equal(code, 0, output);
    return output;
  }
}
