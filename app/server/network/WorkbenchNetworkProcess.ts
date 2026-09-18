/*
 * Exports:
 * - default WorkbenchNetworkProcess: verify bundled artifacts and own one cancellable sidecar pipe lifecycle.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  WORKBENCH_NETWORK_PROTOCOL, WorkbenchNetworkCommandSchema, WorkbenchNetworkPipeResponseSchema,
  type WorkbenchNetworkCommand, type WorkbenchNetworkResult, type WorkbenchNetworkRuntime, type WorkbenchNetworkMember,
} from "workbench-shared/http/workbench-network";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactSchema = z.object({ file: z.string(), sha256: digest, sourceHash: digest }).strict();
const manifestSchema = z.object({
  protocol: z.literal(WORKBENCH_NETWORK_PROTOCOL),
  artifacts: z.object({ "windows-x64": artifactSchema.optional(), "linux-x64": artifactSchema.optional() }).strict(),
}).strict();

export default class WorkbenchNetworkProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private exited: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private stopped = false;
  private failure: Error | null = null;
  private output = "";
  private readonly pending = new Map<string, {
    action: string;
    resolve: (result: WorkbenchNetworkResult) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly options: {
    root: string;
    warn: (message: string) => void;
    failed?: (message: string) => void;
    persistMember?: (previous: WorkbenchNetworkMember | null, member: WorkbenchNetworkMember) => void;
    spawnChild?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
    stateDirectory: string;
    status: (snapshot: WorkbenchNetworkRuntime) => void;
  }) {}

  static async sourceHash(directory: string): Promise<string> {
    const names = (await fs.readdir(directory))
      .filter(name => name === "go.mod" || name === "go.sum" || (name.endsWith(".go") && !name.endsWith("_test.go")))
      .sort();
    const hash = createHash("sha256");
    for (const name of names) {
      hash.update(name).update("\0");
      hash.update((await fs.readFile(path.join(directory, name), "utf8")).replaceAll("\r\n", "\n"));
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  static async inspect(root: string): Promise<string> {
    if (process.arch !== "x64" || (process.platform !== "win32" && process.platform !== "linux")) {
      throw new Error("A bundled network executable is not available for this host platform.");
    }
    const source = path.join(root, "app/network");
    let manifest: z.infer<typeof manifestSchema>;
    try {
      manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(source, "bin/manifest.json"), "utf8")));
    } catch {
      throw new Error("The bundled network manifest is missing or invalid; rebuild the network executable.");
    }
    const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
    const name = process.platform === "win32" ? "workbench-network.exe" : "workbench-network";
    const artifact = manifest.artifacts[platform];
    if (!artifact || artifact.file !== `${platform}/${name}`) throw new Error("The network executable for this host has not been published.");
    const executable = path.join(source, "bin", platform, name);
    const bytes = await fs.readFile(executable);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("The network executable does not match its manifest.");
    if (await WorkbenchNetworkProcess.sourceHash(source) !== artifact.sourceHash) throw new Error("Network sources changed; rebuild the bundled executable.");
    return executable;
  }

  start() {
    this.starting ??= this.open().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error("Network executable startup failed.");
      this.fail(failure);
      throw failure;
    });
    return this.starting;
  }

  async request(command: WorkbenchNetworkCommand): Promise<WorkbenchNetworkResult> {
    const { action, ...payload } = WorkbenchNetworkCommandSchema.parse(command);
    await this.start();
    return await this.send(action, payload);
  }

  async cancelPending() {
    const targets = [...this.pending].filter(([, pending]) => pending.action !== "cancel" && pending.action !== "persist-member-result").map(([id]) => id);
    await Promise.all(targets.map(async id => await this.send("cancel", { id })));
  }

  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    const previousFailure = this.failure;
    this.closing = (async () => {
      // Startup failures have already reached both their caller and fail().
      if (this.starting) await Promise.allSettled([this.starting]);
      this.rejectPending(new Error("Network process closed."));
      this.child?.stdin.end();
      await this.exited;
      if (this.failure && this.failure !== previousFailure) throw this.failure;
    })();
    return this.closing;
  }

  private async open() {
    const executable = await WorkbenchNetworkProcess.inspect(this.options.root);
    if (this.stopped) return;
    const environment = { ...process.env };
    for (const key of ["TS_AUTHKEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL"]) delete environment[key];
    const options: SpawnOptionsWithoutStdio = {
      cwd: this.options.root, env: environment, windowsHide: true,
    };
    const args = ["--state-dir", this.options.stateDirectory];
    const child = this.options.spawnChild
      ? this.options.spawnChild(executable, args, options)
      : spawn(executable, args, { ...options, stdio: "pipe" });
    this.child = child;
    this.exited = new Promise(resolve => {
      child.once("close", (code, signal) => {
        if (!this.failure && (!this.stopped || code !== 0)) {
          this.fail(new Error(`Network process exited unexpectedly (${signal ?? code ?? "unknown"}).`));
        }
        this.child = null;
        this.rejectPending(this.failure ?? new Error("Network process closed."));
        resolve();
      });
    });
    child.once("error", () => this.fail(new Error("Network process could not run.")));
    child.stdin.on("error", () => {
      if (!this.stopped) this.fail(new Error("Network command pipe failed."));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      // Dependency diagnostics are unstructured and may contain login secrets.
      this.options.warn(`Network process emitted a diagnostic (${chunk.length} bytes); raw content was withheld.`);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("Network process could not start.")));
    });
  }

  private send(action: string, payload: object): Promise<WorkbenchNetworkResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopped || !this.child) return Promise.reject(new Error("Network process is not running."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { action, resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ id, action, payload })}\n`, error => {
        if (error && !this.stopped) this.fail(new Error("Network command could not be sent."));
      });
    });
  }

  private receive(chunk: string) {
    if (this.failure) return;
    this.output += chunk;
    for (;;) {
      const newline = this.output.indexOf("\n");
      if (newline < 0) break;
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > 8_388_608) {
        this.fail(new Error("Network process response exceeded its size limit."));
        return;
      }
      try {
        const message = WorkbenchNetworkPipeResponseSchema.parse(JSON.parse(line));
        if ("event" in message) {
          if (this.stopped) continue;
          if (message.event === "status") this.options.status(message.snapshot);
          else {
            let accepted = false;
            try {
              if (!this.options.persistMember) throw new Error("No membership persistence owner.");
              this.options.persistMember(message.previous, message.member);
              accepted = true;
            } catch {
              this.options.warn("Native membership change could not be persisted.");
            }
            void this.send("persist-member-result", { requestId: message.id, accepted }).catch(error => {
              if (!this.stopped) this.fail(error instanceof Error ? error : new Error("Membership persistence acknowledgement failed."));
            });
          }
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          if (this.stopped) continue;
          throw new Error("Unexpected network response identity.");
        }
        this.pending.delete(message.id);
        if ("error" in message) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } catch {
        this.fail(new Error("Network process returned an invalid response; its content was withheld."));
        return;
      }
    }
    if (Buffer.byteLength(this.output, "utf8") > 8_388_608) {
      this.fail(new Error("Network process response exceeded its size limit."));
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.options.warn(error.message);
    this.options.failed?.(error.message);
    this.rejectPending(error);
    this.child?.kill();
  }
}
