/*
 * Keywords: isolated runtime, source copy, paid diagnostic, process lifecycle, RPC.
 * Exports:
 * - default IsolatedWorkbench: boot current source with private storage and own its socket/process cleanup.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createSpawnOptions, killProcessTreeAsync } from "../daemon/orchestrator/process-helpers";
import { CodexAppServerClient } from "../shared/codex/app-server-client";
import { isCodexJsonRpcFailure } from "../shared/codex/protocol";
import WorkbenchTranscriptClient from "../app/workbench/database/transcript/WorkbenchTranscriptClient";

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; workbenchEventStreamSequence?: number };

export default class IsolatedWorkbench {
  readonly events: Message[] = [];
  private readonly observers = new Set<() => void>();
  private child: ChildProcess | null = null;
  private client: CodexAppServerClient | null = null;
  private transcriptClient: WorkbenchTranscriptClient | null = null;
  private log = "";
  private closed = false;
  private constructor(readonly root: string, readonly project: string, readonly origin: string, private readonly openCodePort: number, readonly signal: AbortSignal) {}

  get transcripts() {
    assert.ok(this.transcriptClient, "Diagnostic transcript client must be connected");
    return this.transcriptClient;
  }

  static async create(source: string, signal: AbortSignal) {
    const fixtures = path.join(source, ".workbench", "diagnostics");
    await fs.mkdir(fixtures, { recursive: true });
    const root = await fs.mkdtemp(path.join(fixtures, "wb-live-"));
    const project = path.join(root, "projects", "fixture");
    await fs.mkdir(project, { recursive: true });
    const ignored = new Set(["node_modules", ".workbench", ".git", ".next", "dist", ".env.local"]);
    for (const directory of ["app", "daemon", "shared", "instructions", "runner", "package"]) {
      await fs.cp(path.join(source, directory), path.join(project, directory), {
        recursive: true, filter: (file) => !ignored.has(path.basename(file)),
      });
    }
    await fs.copyFile(path.join(source, "package.json"), path.join(project, "package.json"));
    await fs.copyFile(path.join(source, ".gitignore"), path.join(project, ".gitignore"));
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
    await this.command("git", ["config", "user.name", "Workbench diagnostic"], project, process.env, signal);
    await this.command("git", ["config", "user.email", "diagnostic@localhost"], project, process.env, signal);
    await this.command("git", ["-c", "user.name=Workbench diagnostic", "-c", "user.email=diagnostic@localhost",
      "commit", "--allow-empty", "-qm", "isolated diagnostic fixture"], project, process.env, signal);
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening", { signal });
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const providerListener = net.createServer();
    providerListener.listen(0, "127.0.0.1");
    await once(providerListener, "listening", { signal });
    const providerAddress = providerListener.address();
    assert.ok(providerAddress && typeof providerAddress !== "string");
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => providerListener.close((error) => error ? reject(error) : resolve()));
    if (process.platform === "win32") {
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
    return new IsolatedWorkbench(root, project, `http://127.0.0.1:${port}`, providerAddress.port, signal);
  }

  async start(profileDocument: object, prefixProof: string) {
    this.closed = false;
    const logOffset = this.log.length;
    const home = path.join(this.root, "codex");
    const library = path.join(this.root, "library");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(library, { recursive: true });
    await fs.mkdir(path.join(this.root, "user"), { recursive: true });
    await fs.mkdir(path.join(this.project, ".workbench", "runtime"), { recursive: true });
    await fs.writeFile(path.join(this.project, ".workbench", "runtime", "composer-profiles.json"), JSON.stringify(profileDocument));
    await fs.writeFile(path.join(this.project, "AGENTS.md"), `For the live startup diagnostic, include ${prefixProof} in your final reply. Do not edit files or start other agents.\n`);
    const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    await fs.copyFile(path.join(originalHome, "auth.json"), path.join(home, "auth.json"));
    await fs.writeFile(path.join(home, "config.toml"), 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n'
      + (process.platform === "win32" ? '[windows]\nsandbox = "elevated"\n' : ""));
    const env = {
      ...process.env, CODEX_HOME: home, WORKBENCH_LIBRARY_ROOT: library,
      HOME: path.join(this.root, "user"), USERPROFILE: path.join(this.root, "user"),
      WORKBENCH_PROJECTS_ROOT: path.dirname(this.project),
      WORKBENCH_ORCHESTRATOR_LOOP: "1",
      WORKBENCH_TEMPORARY_ROOT: path.join(this.project, ".workbench", "tmp"),
      TSX_TSCONFIG_PATH: path.join(this.project, "daemon", "tsconfig.json"),
      CODEX_APP_SERVER_URL: this.origin.replace("http:", "ws:"),
      XDG_DATA_HOME: path.join(this.root, "data"), XDG_CONFIG_HOME: path.join(this.root, "config"),
      XDG_CACHE_HOME: path.join(this.root, "cache"), NO_COLOR: "1",
      OPENCODE_SERVER_PORT: String(this.openCodePort),
    };
    const child = spawn(process.execPath, ["--import", "tsx", "orchestrator/index.ts"], {
      ...createSpawnOptions(path.join(this.project, "daemon"), env, true),
      windowsVerbatimArguments: false, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const collect = (chunk: Buffer) => {
      this.log += chunk.toString();
      appendFileSync(path.join(this.root, "orchestrator.log"), chunk);
      for (const observer of this.observers) observer();
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.once("exit", () => { for (const observer of this.observers) observer(); });
    await this.until(() => {
      if (child.exitCode !== null) throw new Error(`Isolated daemon exited ${child.exitCode}\n${this.log.slice(-12000)}`);
      return this.log.slice(logOffset).includes("[codex-bridge] listening on");
    });
    const client = new CodexAppServerClient();
    this.client = client;
    this.transcriptClient = new WorkbenchTranscriptClient({
      transport: {
        onDisconnect: (listener) => client.onConnectionClose(listener),
        onNotification: (listener) => client.onWorkbenchNotification(listener),
        request: (method, params) => this.request(method, params),
      },
      reportConformance: (report) => console.error("Diagnostic transcript conformance failure", report),
    });
    client.onNotification((message) => {
      this.events.push(message as Message);
      for (const observer of this.observers) observer();
    });
    client.onWorkbenchNotification((message) => {
      this.events.push(message as Message);
      for (const observer of this.observers) observer();
    });
    await this.withSignal(client.connect(this.origin.replace("http:", "ws:")), this.signal);
  }

  async request<T = unknown>(method: string, params: unknown = {}, fields: object = {}, signal = this.signal): Promise<T> {
    if (this.closed || !this.client) throw new Error("Isolated runtime is not connected");
    signal.throwIfAborted();
    const response = await this.withSignal(this.client.sendRequest<T>({ method, params, ...fields }), signal);
    if (isCodexJsonRpcFailure(response)) throw new Error(response.error.message);
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
    this.closed = true;
    this.transcriptClient?.dispose();
    this.transcriptClient = null;
    this.client?.dispose();
    this.client = null;
    if (this.child) {
      const child = this.child;
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const signal = AbortSignal.timeout(45_000);
          const exited = once(child, "exit", { signal }).then(
            () => null,
            (error: Error) => error,
          );
          // Keep the root alive until its descendants are retired. Exiting the
          // daemon first can orphan a provider that still owns transcript locks.
          assert.ok(child.pid, "Diagnostic process must have an owned PID");
          if (process.platform === "win32") {
            await IsolatedWorkbench.command("pwsh", ["-NoProfile", "-Command", `
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process)
$owned = @($processes | Where-Object ProcessId -EQ ${child.pid})
if ($owned.Count -ne 1) { throw 'Diagnostic root process disappeared before retirement' }
do {
  $ids = @($owned.ProcessId)
  $added = @($processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
  $owned += $added
} while ($added.Count -gt 0)
& taskkill /PID ${child.pid} /T /F 2>&1 | Out-String | Write-Output
$survivors = @(Get-CimInstance Win32_Process | Where-Object {
  $current = $_
  $owned | Where-Object { $_.ProcessId -eq $current.ProcessId -and $_.CreationDate -eq $current.CreationDate }
})
if ($survivors.Count) { throw "Diagnostic process tree still alive: $($survivors.ProcessId -join ', ')" }
exit 0
`], this.project, process.env, signal);
          } else {
            await killProcessTreeAsync(child.pid);
          }
          const exitError = await exited;
          if (exitError) throw exitError;
        }
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      this.child = null;
    }
  }

  async close() {
    try {
      await this.stop();
    } finally {
      await fs.writeFile(path.join(this.root, "orchestrator.log"), this.log);
      const auth = path.resolve(this.root, "codex", "auth.json");
      assert.ok(auth.startsWith(`${path.resolve(this.root)}${path.sep}`));
      await fs.rm(auth, { force: true });
      if (process.platform === "win32") {
        // Unlink these exact fixture entries. Recursive removal could reach the
        // shared sandbox identity and must never be used here.
        await fs.unlink(path.join(this.root, "codex", ".sandbox-secrets"));
        await fs.unlink(path.join(this.root, "codex", ".sandbox", "setup_marker.json"));
      }
    }
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
