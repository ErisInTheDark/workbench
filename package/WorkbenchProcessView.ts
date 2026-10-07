/*
 * Exports:
 * - default WorkbenchProcessView: own the detachable terminal log view, pinned keybind legend and lifecycle controls.
 */
import type { ReadStream } from "node:tty";
import WorkbenchLogFollower from "../shared/process/WorkbenchLogFollower.ts";
import ProcessViewStatusLine from "./ProcessViewStatusLine.ts";
import type { ProcessViewControls, ProcessViewControlsSnapshot } from "./WorkbenchProcessViewControls.ts";

type ViewInput = Pick<ReadStream, "isTTY" | "isRaw" | "setRawMode" | "on" | "off" | "resume" | "pause">;
type ViewStatusLine = Pick<ProcessViewStatusLine, "enabled" | "install" | "update" | "notice" | "close">;

const ANSI_DIM = "\u001b[2m";
const ANSI_DIM_OFF = "\u001b[22m";

const UNAVAILABLE: ProcessViewControlsSnapshot = { host: false, daemon: false, app: false };

function renderLegend(snapshot: ProcessViewControlsSnapshot, forceArmed: boolean) {
  const entry = (key: string, label: string, enabled: boolean) => enabled
    ? `${key} ${label}`
    : `${ANSI_DIM}${key} ${label}${ANSI_DIM_OFF}`;
  return [
    "q exit",
    entry("d", "kill daemon", snapshot.host && snapshot.daemon),
    forceArmed ? "h FORCE HALT" : entry("h", "kill host", snapshot.host && snapshot.app),
    entry("a", "kill app", snapshot.app),
    entry("s", "start app", !snapshot.app),
  ].join("  ");
}

export default class WorkbenchProcessView {
  private closed = false;
  private release: (() => void) | null = null;
  private commands = Promise.resolve();
  private forceArmed = false;
  private controls: ProcessViewControls | null = null;
  private statusLine: ViewStatusLine | null = null;
  private notice: (message: string) => void;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: {
    input: ViewInput;
    write(text: string): Promise<void>;
    warn(message: string): void;
    logDirectory: string;
    prefixes: readonly string[];
    openControls(warn: (message: string) => void): Promise<ProcessViewControls>;
    createFollower?: (options: ConstructorParameters<typeof WorkbenchLogFollower>[0]) => Pick<WorkbenchLogFollower, "start" | "close">;
    createStatusLine?: () => ViewStatusLine;
  }) {
    this.notice = options.warn;
  }

  async run() {
    if (this.closed || this.release) throw new Error("Process view has already started or closed.");
    const detached = new Promise<void>(resolve => { this.release = resolve; });
    const statusLine = (this.options.createStatusLine ?? (() => new ProcessViewStatusLine(process.stdout)))();
    this.statusLine = statusLine;
    this.notice = message => statusLine.notice(message);
    statusLine.install();
    const wasRaw = this.options.input.isRaw;
    let follower: Pick<WorkbenchLogFollower, "start" | "close"> | null = null;
    let unsubscribe: (() => void) | null = null;
    const failed = (error: Error) => { this.notice(error.message); this.detach(); };
    const end = () => this.detach();
    const data = (bytes: Buffer | string) => { for (const key of bytes.toString()) this.handleKey(key); };
    try {
      if (this.closed) return;
      follower = (this.options.createFollower ?? (configuration => new WorkbenchLogFollower(configuration)))({
        directory: this.options.logDirectory,
        prefix: this.options.prefixes,
        write: this.options.write,
        failed,
      });
      // Logs never wait for a process: a failing startup is exactly what the view must show.
      await follower.start();
      try {
        this.controls = await this.options.openControls(this.notice);
        unsubscribe = this.controls.subscribe(() => this.renderLegend());
      } catch (error) {
        if (!this.closed) this.notice(`Process controls are unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.renderLegend();
      if (this.options.input.isTTY) {
        this.options.input.setRawMode(true);
        this.options.input.on("data", data);
        this.options.input.on("end", end);
        this.options.input.on("error", failed);
        this.options.input.resume();
      } else {
        await this.options.write("\nViewing logs without interactive controls. Terminating this view leaves the process running.\n");
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
      unsubscribe?.();
      const results = await Promise.allSettled([
        (async () => { await this.controls?.close(); })(),
        follower?.close(),
        (async () => { statusLine.close(); })(),
      ]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Process view cleanup failed.");
    }
  }

  detach() {
    this.closed = true;
    this.lifetime.abort(new Error("Process view detached."));
    this.release?.();
  }

  private handleKey(key: string) {
    if (key === "q" || key === "Q" || key === "\u0003") { this.detach(); return; }
    switch (key.toLowerCase()) {
      case "d": this.enqueue(() => this.act("daemon")); break;
      case "h": this.enqueue(() => this.act("host")); break;
      case "a": this.enqueue(() => this.act("app")); break;
      case "s": this.enqueue(() => this.act("start")); break;
      default: break;
    }
  }

  private enqueue(task: () => Promise<void>) {
    this.commands = this.commands.then(async () => {
      if (this.closed) return;
      try { await task(); }
      catch (error) {
        if (!this.closed) this.notice(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async act(kind: "daemon" | "host" | "app" | "start") {
    const controls = this.controls;
    if (!controls) { this.notice("Process controls are unavailable."); return; }
    const snapshot = controls.snapshot();
    try {
      if (kind === "daemon") {
        if (!snapshot.host || !snapshot.daemon) { this.notice("Kill daemon is unavailable: the daemon is not ready."); return; }
        await controls.killDaemon(this.lifetime.signal);
      } else if (kind === "host") {
        if (this.forceArmed) {
          this.forceArmed = false;
          await controls.forceStopHost();
        } else {
          if (!snapshot.host || !snapshot.app) { this.notice("Kill host is unavailable: the app must be running to restart it."); return; }
          await controls.killHost();
        }
      } else if (kind === "app") {
        if (!snapshot.app) { this.notice("Kill app is unavailable: the app is not running."); return; }
        await controls.killApp();
      } else {
        if (snapshot.app) { this.notice("Start app is unavailable: the app is already running."); return; }
        await controls.startApp();
      }
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      if (kind === "daemon" || kind === "host") {
        this.forceArmed = true;
        this.notice(`${message}\nHost force-halt armed: press h to force-stop the host.`);
      } else {
        this.notice(message);
      }
    }
    this.renderLegend();
  }

  private renderLegend() {
    if (!this.statusLine?.enabled) return;
    const snapshot = this.controls?.snapshot() ?? UNAVAILABLE;
    this.statusLine.update(renderLegend(snapshot, this.forceArmed));
  }
}
