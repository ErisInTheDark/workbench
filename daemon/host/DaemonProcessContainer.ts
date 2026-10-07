/*
 * Exports:
 * - DaemonProcessContainerOptions: platform, command and native holder boundaries for one daemon run.
 * - default DaemonProcessContainer: spawn one daemon inside its own disposable process container and empty it.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import NativeArtifactStage from "../../shared/process/NativeArtifactStage.ts";
import { DaemonOwnedMessageSchema } from "../../shared/http/workbench-daemon-lifecycle.ts";

export interface DaemonProcessContainerOptions {
  root: string;
  environment: NodeJS.ProcessEnv;
  /** Retires a process tree by its root pid; used where no container exists. */
  killTree(pid: number | undefined): Promise<void>;
  warn(message: string): void;
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  /** Runs one short platform command, rejecting with its stderr. */
  run?: (command: string, args: readonly string[]) => Promise<void>;
  /** The systemd unit that owns this host, or null outside systemd. */
  hostUnit?: () => string | null;
  /** The runnable copy of the native binary that holds Windows daemon jobs. */
  holderExecutable?: () => Promise<string>;
}

const execFileAsync = promisify(execFile);

async function runCommand(command: string, args: readonly string[]) {
  try { await execFileAsync(command, [...args], { windowsHide: true }); }
  catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`${command} ${args[0] ?? ""} failed${stderr ? `: ${stderr.slice(0, 500)}` : "."}`, { cause: error });
  }
}

/** Reads the owning unit from cgroup v2 membership, e.g. `.../app.slice/workbench-host.service`. */
function readHostUnit() {
  const membership = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"));
  return membership?.slice(3).split("/").reverse().find(segment => segment.endsWith(".service")) ?? null;
}

const notLoaded = (error: unknown) => error instanceof Error && /not loaded|not found/iu.test(error.message);

/**
 * One container per daemon run. Linux runs the daemon in a transient systemd scope bound to the host unit;
 * Windows has the native binary hold a kill-on-close job around it. Disposal ends every descendant, including
 * orphans of a daemon that already crashed, which a parent-to-child tree walk can no longer find.
 */
export default class DaemonProcessContainer {
  private readonly platform: NodeJS.Platform;
  private child: ChildProcess | null = null;
  private scope: string | null = null;
  private holder: ChildProcess | null = null;
  private holding: Promise<void> = Promise.resolve();

  constructor(private readonly options: DaemonProcessContainerOptions) {
    this.platform = options.platform ?? process.platform;
  }

  spawn(command: string, args: readonly string[], spawnOptions: SpawnOptions): ChildProcess {
    if (this.child) throw new Error("A daemon process container holds exactly one daemon.");
    const start = this.options.spawn ?? spawn;
    if (this.platform === "linux") {
      const hostUnit = (this.options.hostUnit ?? readHostUnit)();
      if (!hostUnit) {
        this.options.warn("The host is not running in a systemd unit; daemon descendants in other process groups cannot be contained.");
        this.child = start(command, [...args], spawnOptions);
        return this.child;
      }
      this.scope = `workbench-daemon-${randomUUID()}.scope`;
      // --scope execs the command in place, so the pid and Node's IPC channel survive.
      this.child = start("systemd-run", [
        "--user", "--scope", "--quiet", "--collect", `--unit=${this.scope}`,
        `--property=BindsTo=${hostUnit}`, `--property=After=${hostUnit}`, "--", command, ...args,
      ], spawnOptions);
      return this.child;
    }
    if (this.platform !== "win32") {
      this.child = start(command, [...args], spawnOptions);
      return this.child;
    }
    const child = start(command, [...args], {
      ...spawnOptions, env: { ...(spawnOptions.env ?? process.env), WORKBENCH_DAEMON_ACK_REQUIRED: "1" },
    });
    this.child = child;
    this.holding = this.hold(child).catch(error => {
      this.options.warn(`Daemon process container failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
      // Unacknowledged, the daemon has spawned nothing yet; ending it alone is complete.
      child.kill();
    });
    return child;
  }

  /** Ends the daemon and every descendant. Safe after the daemon exited and when called more than once. */
  async dispose() {
    const child = this.child;
    if (!child) return;
    if (this.scope) {
      for (const args of [["kill", "--signal=SIGKILL", this.scope], ["stop", this.scope]]) {
        try { await (this.options.run ?? runCommand)("systemctl", ["--user", ...args]); }
        catch (error) { if (!notLoaded(error)) throw error; }
      }
      // Disposal can race systemd-run before its scope exists; that launcher is still in the daemon's own group.
      if (child.exitCode === null && child.signalCode === null) await this.options.killTree(child.pid);
      return;
    }
    if (this.platform !== "win32") {
      await this.options.killTree(child.pid);
      return;
    }
    await this.holding;
    const holder = this.holder;
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const exited = new Promise<void>(resolve => holder.once("exit", () => resolve()));
      // Closing stdin makes the holder terminate its job, ending the daemon's whole tree.
      holder.stdin?.end();
      await exited;
    }
    if (child.exitCode === null && child.signalCode === null) await this.options.killTree(child.pid);
  }

  private async hold(child: ChildProcess) {
    const executable = await (this.options.holderExecutable ?? (() => new NativeArtifactStage({
      runtimeRoot: this.options.environment.WORKBENCH_DATA_ROOT, warn: this.options.warn,
    }).stage({
      label: "host",
      executable: path.join(this.options.root, "daemon", "host", "bin", `windows-${process.arch}`, "workbench-daemon-host.exe"),
    })))();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error("The daemon exited before its job was created.");
    const holder = (this.options.spawn ?? spawn)(executable, ["job-hold", String(child.pid)], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.holder = holder;
    // A holder that later fails closes its job, which ends the daemon and surfaces as a daemon exit.
    holder.on("error", error => this.options.warn(`Daemon job holder failed: ${error.message.slice(0, 500)}`));
    await new Promise<void>((resolve, reject) => {
      let output = "";
      let errors = "";
      const cleanup = () => {
        holder.stdout?.off("data", read);
        holder.stderr?.off("data", readError);
        holder.off("exit", exited);
        holder.off("error", reject);
      };
      const read = (bytes: Buffer) => {
        output += bytes.toString();
        if (output.includes("owned\n") || output.includes("owned\r\n")) { cleanup(); resolve(); }
      };
      const readError = (bytes: Buffer) => { errors = `${errors}${bytes.toString()}`.slice(-500); };
      const exited = (code: number | null) => {
        cleanup();
        reject(new Error(`Daemon job holder exited with ${code ?? "a signal"}${errors.trim() ? `: ${errors.trim()}` : "."}`));
      };
      holder.stdout?.on("data", read);
      holder.stderr?.on("data", readError);
      holder.once("exit", exited);
      holder.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      if (!child.connected || !child.send) { reject(new Error("Daemon IPC is unavailable.")); return; }
      child.send(DaemonOwnedMessageSchema.parse({ type: "workbench-daemon-owned" }), error => error ? reject(error) : resolve());
    });
  }
}
