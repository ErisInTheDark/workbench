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
  stopDaemon(): Promise<void>;
  stopHost(): Promise<void>;
  quitApp(): Promise<void>;
  close(): Promise<void>;
}

export default class WorkbenchProcessView {
  private closed = false;
  private release: (() => void) | null = null;
  private commands = Promise.resolve();
  private stage: "daemon" | "host" = "daemon";
  private readonly lifetime = new AbortController();

  constructor(private readonly options: {
    target: "daemon" | "app";
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
        if (key === "q" || key === "Q") this.detach();
        if (key !== "\u0003" || this.closed) continue;
        this.commands = this.commands.then(async () => {
          if (this.closed) return;
          if (this.options.target === "app") {
            await connection.quitApp();
            this.detach();
          } else if (this.stage === "daemon") {
            await connection.stopDaemon();
            this.stage = "host";
            await this.options.write("\nDaemon stopped. Ctrl+C again stops the host; q detaches.\n");
          } else {
            await connection.stopHost();
            this.detach();
          }
        }).catch(error => {
          if (!this.closed) this.options.warn(`Stop failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    };
    const end = () => this.detach();
    const failed = (error: Error) => { this.options.warn(error.message); this.detach(); };
    try {
      if (this.closed) return;
      follower = (this.options.createFollower ?? (options => new WorkbenchLogFollower(options)))({
        directory: connection.logDirectory, prefix: connection.logPrefix, write: this.options.write, failed,
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
      await this.commands;
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Process view cleanup failed.");
    }
  }

  detach() {
    this.closed = true;
    this.lifetime.abort(new Error("Process view detached."));
    this.release?.();
  }
}
