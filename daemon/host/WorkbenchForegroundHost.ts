/*
 * Exports:
 * - default WorkbenchForegroundHost: own a terminal-bound supervised host, its output and shutdown.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import WorkbenchServiceClient from "../../shared/process/WorkbenchServiceClient.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";

const READY_PREFIX = "\u001eWORKBENCH_HOST_V1 ";
type Control = Pick<WorkbenchServiceClient, "start" | "request" | "close">;

export default class WorkbenchForegroundHost {
  private child: ChildProcess | null = null;
  private control: Control | null = null;
  private endpoint: WorkbenchServiceEndpoint | null = null;
  private stopping: Promise<void> | null = null;
  private closed = false;
  private running = false;
  private readonly cancellation = new AbortController();

  constructor(private readonly options: {
    root: string;
    dataRoot: string;
    output(text: string): void;
    warn(text: string): void;
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    read?: () => Promise<WorkbenchServiceEndpoint | null>;
    verify?: typeof verifyServiceEndpoint;
    createControl?: () => Control;
  }) {}

  private read() {
    return this.options.read?.() ?? readServiceEndpoint(path.join(this.options.dataRoot, "service", "runtime.json"));
  }

  async run() {
    if (this.running || this.closed) throw new Error("Foreground host has already started or closed.");
    this.running = true;
    const existing = await this.read();
    if (existing) {
      try {
        await (this.options.verify ?? verifyServiceEndpoint)(existing, this.cancellation.signal);
        throw new Error("Workbench is already launched. Use wb view daemon to view its output.");
      } catch (error) {
        if (this.closed) return;
        // A dead publication after an abrupt process exit is expected. All other
        // verification failures must remain visible, not become launch permission.
        const cause = error instanceof Error && "cause" in error ? error.cause : null;
        if (!(cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED")) throw error;
        this.options.warn("Previous host publication is no longer listening; attempting a new foreground launch.");
      }
    }
    if (this.closed) return;
    const platform = this.options.platform ?? process.platform;
    const environment = { ...(this.options.environment ?? process.env), WORKBENCH_DATA_ROOT: this.options.dataRoot };
    let command: string;
    let args: string[];
    if (platform === "win32") {
      command = path.join(this.options.root, "daemon", "host", "bin", `windows-${process.arch}`, "workbench-daemon-host.exe");
      args = [this.options.root, process.execPath, this.options.dataRoot, "--foreground"];
    } else if (platform === "linux") {
      command = "systemd-run";
      const session = randomUUID();
      const inherited = Object.keys(environment).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
        .filter(key => !["WORKBENCH_SERVICE_RUNTIME", "WORKBENCH_SERVICE_ACK_REQUIRED", "WORKBENCH_SERVICE_SESSION", "WORKBENCH_FOREGROUND_PIPE"].includes(key));
      args = [
        "--user", "--wait", "--pipe", "--collect", "--quiet", "--expand-environment=no",
        `--unit=workbench-dev-${session}.service`, `--working-directory=${this.options.root}`,
        "--property=Type=exec", "--property=KillMode=mixed", "--property=Restart=on-failure",
        "--property=RestartPreventExitStatus=78", "--property=TimeoutStopSec=infinity",
        ...inherited.map(key => `--setenv=${key}`),
        `--setenv=WORKBENCH_SERVICE_SESSION=${session}`, "--setenv=WORKBENCH_FOREGROUND_PIPE=1",
        "--", process.execPath, path.join(this.options.root, "daemon", "host", "launch-node.mjs"),
      ];
    } else throw new Error(`Foreground daemon supervision is unavailable on ${platform}.`);

    const child = (this.options.spawn ?? spawn)(command, args, {
      cwd: this.options.root, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let failure: Error | null = null;
    let attachment = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    const line = (text: string) => {
      if (text === "workbench-host-ready") return;
      if (!text.startsWith(READY_PREFIX)) { this.options.output(`${text}\n`); return; }
      attachment = attachment.then(async () => {
        if (this.closed) return;
        const record: { pid?: number } = JSON.parse(text.slice(READY_PREFIX.length));
        if (!Number.isSafeInteger(record.pid) || record.pid! <= 1) throw new Error("Invalid foreground readiness record.");
        const endpoint = await this.read();
        if (!endpoint || endpoint.pid !== record.pid) throw new Error("Foreground readiness does not match its owned host.");
        await (this.options.verify ?? verifyServiceEndpoint)(endpoint, this.cancellation.signal);
        if (this.closed) return;
        await this.control?.close();
        this.endpoint = null;
        const control = this.options.createControl?.() ?? new WorkbenchServiceClient({
          endpointPath: path.join(this.options.dataRoot, "service", "runtime.json"), warn: this.options.warn,
        });
        this.control = control;
        await control.start();
        if (!this.closed) {
          this.endpoint = endpoint;
          await control.request({ method: "service/daemon/wake", retry: false });
        }
      }).catch(error => {
        if (this.closed) return;
        failure = error instanceof Error ? error : new Error(String(error));
        this.options.warn(failure.message);
        // This pipe belongs to this launch, unlike a detachable view.
        child.stdin?.end();
      });
    };
    child.stdout?.on("data", (bytes: Buffer) => {
      buffered += decoder.write(bytes);
      while (buffered.includes("\n")) {
        const end = buffered.indexOf("\n");
        line(buffered.slice(0, end).replace(/\r$/u, ""));
        buffered = buffered.slice(end + 1);
      }
      if (buffered.length > 16_384) { this.options.output(buffered); buffered = ""; }
    });
    child.stderr?.on("data", (bytes: Buffer) => this.options.output(bytes.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          const remaining = buffered + decoder.end();
          if (remaining) line(remaining);
          if (code === 0 || this.closed) resolve();
          else reject(new Error(`Foreground host exited with ${signal ?? code ?? "unknown status"}.`));
        });
      });
      await attachment;
      if (failure) throw failure;
    } finally {
      this.closed = true;
      child.stdin?.end();
      await attachment;
      await this.control?.close();
      this.control = null;
      this.child = null;
    }
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.cancellation.abort(new Error("Foreground host stopped."));
    this.stopping = (async () => {
      try {
        if (this.control && this.endpoint) {
          await this.control.request({ method: "service/stop", instanceId: this.endpoint.instanceId });
        } else await this.control?.close();
      } finally { this.child?.stdin?.end(); }
    })();
    return this.stopping;
  }
}
