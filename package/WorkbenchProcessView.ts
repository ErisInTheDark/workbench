/*
 * Exports:
 * - ProcessViewConnection: authenticated lifecycle controls and persisted log location.
 * - default WorkbenchProcessView: own detachable terminal input and explicit stop intent.
 */
import type { ReadStream } from "node:tty";
import WorkbenchLogFollower from "../shared/process/WorkbenchLogFollower.ts";

export interface ProcessViewConnection {
  logDirectory: string;
  logPrefix: "workbench-host" | "workbench-app";
  stopDaemon(signal: AbortSignal): Promise<void>;
  stopHost(): Promise<void>;
  emergencyStopHost(): Promise<void>;
  quitApp(): Promise<void>;
  close(): Promise<void>;
}

export default class WorkbenchProcessView {
  private closed = false;
  private release: (() => void) | null = null;
  private commands = Promise.resolve();
  private stage: "daemon" | "stopping-daemon" | "host" | "emergency" = "daemon";
  private stopAbort: AbortController | null = null;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: {
    target: "daemon" | "app" | "all";
    input: Pick<ReadStream, "isTTY" | "isRaw" | "setRawMode" | "on" | "off" | "resume" | "pause">;
    write(text: string): Promise<void>;
    warn(message: string): void;
    connect(signal: AbortSignal): Promise<ProcessViewConnection>;
    createFollower?: (options: ConstructorParameters<typeof WorkbenchLogFollower>[0]) => Pick<WorkbenchLogFollower, "start" | "close">;
  }) {}

  async run() {
    if (this.closed || this.release) throw new Error("Process view has already started or closed.");
    const detached = new Promise<void>(resolve => { this.release = resolve; });
    let connection: ProcessViewConnection;
    try { connection = await this.options.connect(this.lifetime.signal); }
    catch (error) { if (this.closed) return; throw error; }
    let follower: Pick<WorkbenchLogFollower, "start" | "close"> | null = null;
    const wasRaw = this.options.input.isRaw;
    const data = (bytes: Buffer | string) => {
      for (const key of bytes.toString()) {
        if (key === "q" || key === "Q") { this.detach(); continue; }
        if (key !== "\u0003" || this.closed) continue;
        if (this.options.target === "daemon" && this.stage === "stopping-daemon") {
          this.stage = "emergency";
          this.stopAbort?.abort(new Error("Viewer escalated to emergency host halt."));
          void connection.emergencyStopHost().then(() => this.detach(), error => {
            if (!this.closed) this.options.warn(`Emergency host halt was not confirmed: ${error instanceof Error ? error.message : String(error)}`);
          });
          continue;
        }
        if (this.options.target === "daemon" && this.stage === "emergency") continue;
        if (this.options.target === "daemon" && this.stage === "daemon") {
          this.stage = "stopping-daemon";
          this.stopAbort = new AbortController();
        }
        this.commands = this.commands.then(async () => {
          if (this.closed) return;
          if (this.options.target !== "daemon") {
            await connection.quitApp();
            this.detach();
          } else if (this.stage === "stopping-daemon") {
            await connection.stopDaemon(this.stopAbort!.signal);
            if (this.closed || this.stage !== "stopping-daemon") return;
            this.stage = "host";
            this.stopAbort = null;
            await this.options.write("\nDaemon stopped. Ctrl+C again stops the host; q detaches.\n");
          } else if (this.stage === "host") {
            await connection.stopHost();
            this.detach();
          }
        }).catch(error => {
          if (this.stage === "stopping-daemon") {
            this.stage = "daemon";
            this.stopAbort = null;
          }
          if (!this.closed && this.stage !== "emergency") this.options.warn(`Stop failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    };
    const end = () => this.detach();
    const failed = (error: Error) => { this.options.warn(error.message); this.detach(); };
    try {
      if (this.closed) return;
      follower = (this.options.createFollower ?? (options => new WorkbenchLogFollower(options)))({
        directory: connection.logDirectory,
        prefix: this.options.target === "all" ? ["workbench-app", "workbench-host"] : connection.logPrefix,
        write: this.options.write, failed,
      });
      await follower.start();
      await this.options.write(this.options.input.isTTY
        ? `\nViewing ${this.options.target}. Ctrl+C ${this.options.target === "daemon" ? "stops the daemon, then the host" : "quits the app and tray"}; q detaches.\n`
        : "\nViewing logs without interactive controls. Terminating this view leaves the process running.\n");
      if (this.options.input.isTTY) {
        this.options.input.setRawMode(true);
        this.options.input.on("data", data);
        this.options.input.on("end", end);
        this.options.input.on("error", failed);
        this.options.input.resume();
      }
      await detached;
    } finally {
      this.closed = true;
      this.options.input.off("data", data);
      this.options.input.off("end", end);
      this.options.input.off("error", failed);
      if (this.options.input.isTTY) {
        this.options.input.setRawMode(Boolean(wasRaw));
        this.options.input.pause();
      }
      // Closing transport cancels outstanding viewer waits, never emits stop.
      const results = await Promise.allSettled([connection.close(), follower?.close()]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Process view cleanup failed.");
    }
  }

  detach() {
    this.closed = true;
    this.lifetime.abort(new Error("Process view detached."));
    this.stopAbort?.abort(new Error("Process view detached."));
    this.release?.();
  }
}
