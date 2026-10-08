/*
 * Exports:
 * - default WorkbenchProcessView: own the detachable terminal log view, pinned log-coloured keybind legend, lifecycle controls,
 *   open-in-browser, and hold-to-confirm reload-all and pull keys.
 */
import type { ReadStream } from "node:tty";
import WorkbenchLogFollower from "../shared/process/WorkbenchLogFollower.ts";
import { logDomainColors, logTimestampColor } from "../shared/process/WorkbenchProcessLogger.ts";
import type { WorkbenchAppControlRuntime } from "../shared/http/workbench-app-control.ts";
import ProcessViewStatusLine from "./ProcessViewStatusLine.ts";
import type { ProcessViewControls, ProcessViewControlsSnapshot } from "./WorkbenchProcessViewControls.ts";
import {
  decodeTerminalInput, KITTY_KEYBOARD_POP, KITTY_KEYBOARD_PUSH, KITTY_KEYBOARD_QUERY, TerminalKeyHold,
  type HoldOutcome, type TerminalKeyEvent,
} from "./terminal-key-hold.ts";

type ViewInput = Pick<ReadStream, "isTTY" | "isRaw" | "setRawMode" | "on" | "off" | "resume" | "pause">;
type ViewStatusLine = Pick<ProcessViewStatusLine, "enabled" | "install" | "update" | "notice" | "close">;
type HoldKey = "r" | "u";

const ANSI_BOLD = "\u001b[1m";
const ANSI_BOLD_OFF = "\u001b[22m";
const ANSI_FOREGROUND_OFF = "\u001b[39m";
const ANSI_INVERSE = "\u001b[7m";
const ANSI_INVERSE_OFF = "\u001b[27m";
const ANSI_RED = "\u001b[31m";
const ANSI_RED_PROGRESS = "\u001b[41;97m";
const ANSI_BACKGROUND_OFF = "\u001b[49;39m";
const ANSI_AMBER = "\u001b[33m";

const NORMAL_HOLD_MS = 1_000;
const DANGER_HOLD_MS = 2_000;
/** Redraw cadence while a hold fills; also how often autorepeat release is checked. */
const HOLD_FRAME_MS = 33;

const UNAVAILABLE: ProcessViewControlsSnapshot = { host: false, daemon: false, app: false, runtime: null };

const OPERATION_LABELS: Partial<Record<WorkbenchAppControlRuntime["operation"]["phase"], string>> = {
  pulling: "pulling", waiting: "reloading", reloading: "reloading", restarting: "restarting",
};

function operationRunning(runtime: WorkbenchAppControlRuntime | null) {
  return Boolean(runtime && runtime.operation.phase !== "idle" && runtime.operation.phase !== "failed");
}

function holdAvailable(key: HoldKey, runtime: WorkbenchAppControlRuntime | null) {
  if (!runtime || operationRunning(runtime)) return false;
  return key === "r" ? runtime.dirty : runtime.update?.state === "available";
}

function holdDanger(key: HoldKey, runtime: WorkbenchAppControlRuntime | null) {
  return key === "r" && Boolean(runtime?.destructive);
}

const entry = (key: string, label: string, enabled: boolean, color = "") => enabled
  ? `${ANSI_BOLD}${key}${ANSI_BOLD_OFF} ${color}${label}${ANSI_FOREGROUND_OFF}`
  : `${logTimestampColor}${key} ${label}${ANSI_FOREGROUND_OFF}`;

/** The label fills left to right as a selection-style progress bar; danger holds turn red. */
function holdingEntry(key: string, label: string, progress: number, danger: boolean) {
  const text = `${key} ${label}`;
  const filled = Math.round(progress * text.length);
  const start = danger ? ANSI_RED_PROGRESS : ANSI_INVERSE;
  const stop = danger ? ANSI_BACKGROUND_OFF : ANSI_INVERSE_OFF;
  const rest = text.slice(filled);
  return `${ANSI_BOLD}${start}${text.slice(0, filled)}${stop}${danger ? ANSI_RED : ""}${rest}${ANSI_FOREGROUND_OFF}${ANSI_BOLD_OFF}`;
}

function holdEntry(key: HoldKey, snapshot: ProcessViewControlsSnapshot, hold: TerminalKeyHold | null, now: number) {
  const runtime = snapshot.runtime;
  const label = key === "r" ? "reload all" : "pull changes";
  if (hold?.key === key) return holdingEntry(key, label, hold.progress(now), holdDanger(key, runtime));
  const running = runtime ? OPERATION_LABELS[runtime.operation.phase] : undefined;
  const action = runtime?.operation.action;
  if (running && (key === "r" ? action === "reloadAll" : action === "pull" || action === "pullAndReload")) {
    return entry(key, `${running}…`, false);
  }
  if (key === "u" && runtime?.update?.state === "conflict") return `${ANSI_AMBER}${key} pull conflicts${ANSI_FOREGROUND_OFF}`;
  return entry(key, label, holdAvailable(key, runtime), holdDanger(key, runtime) ? ANSI_RED : "");
}

/** Lit keys are bold with their label in the log domain colour they act on; unavailable keys use the timestamp grey. */
function renderLegend(snapshot: ProcessViewControlsSnapshot, forceArmed: boolean, hold: TerminalKeyHold | null, now: number) {
  return [
    entry("q", "exit", true),
    holdEntry("r", snapshot, hold, now),
    holdEntry("u", snapshot, hold, now),
    entry("d", "kill daemon", snapshot.host && snapshot.daemon, logDomainColors.daemon),
    entry("h", forceArmed ? "FORCE HALT" : "kill host", forceArmed || (snapshot.host && snapshot.app), logDomainColors.host),
    entry("a", "kill app", snapshot.app, logDomainColors.app),
    entry("s", "start app", !snapshot.app, logDomainColors.app),
    entry("o", "open app", snapshot.app, logDomainColors.app),
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
  private kitty = false;
  private hold: TerminalKeyHold | null = null;
  /** A refused hold still absorbs its own autorepeat, so one press warns once. */
  private refused: TerminalKeyHold | null = null;
  private stopFrames: (() => void) | null = null;

  constructor(private readonly options: {
    input: ViewInput;
    write(text: string): Promise<void>;
    warn(message: string): void;
    logDirectory: string;
    prefixes: readonly string[];
    openControls(warn: (message: string) => void): Promise<ProcessViewControls>;
    createFollower?: (options: ConstructorParameters<typeof WorkbenchLogFollower>[0]) => Pick<WorkbenchLogFollower, "start" | "close">;
    createStatusLine?: () => ViewStatusLine;
    /** Raw terminal control output (keyboard protocol negotiation). */
    writeTerminal?: (text: string) => void;
    now?: () => number;
    /** Repeats `frame` until the returned stop is called. */
    every?: (ms: number, frame: () => void) => () => void;
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
    const data = (bytes: Buffer | string) => {
      const decoded = decodeTerminalInput(bytes.toString());
      if (decoded.kittySupported && !this.kitty) {
        this.kitty = true;
        this.terminal(KITTY_KEYBOARD_PUSH);
      }
      for (const event of decoded.events) this.handleKey(event);
    };
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
        // Terminals with the kitty keyboard protocol answer, enabling real key release; others stay silent.
        this.terminal(KITTY_KEYBOARD_QUERY);
      } else {
        await this.options.write("\nViewing logs without interactive controls. Terminating this view leaves the process running.\n");
      }
      await detached;
    } finally {
      this.closed = true;
      this.endHold();
      this.options.input.off("data", data);
      this.options.input.off("end", end);
      this.options.input.off("error", failed);
      if (this.kitty) this.terminal(KITTY_KEYBOARD_POP);
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

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private terminal(text: string) {
    (this.options.writeTerminal ?? (value => { process.stdout.write(value); }))(text);
  }

  private handleKey(input: TerminalKeyEvent) {
    const now = this.now();
    const event = input.key.length === 1 ? { ...input, key: input.key.toLowerCase() } : input;
    // An autorepeat absorber has no frame timer; a stale one (key since released) ends before this event.
    if (this.refused && this.refused.tick(now) !== "holding") this.refused = null;
    if (this.refused) {
      const outcome = event.type === "press" && event.key !== this.refused.key ? "cancel" : this.refused.accept(event, now);
      if (outcome === "holding") return;
      this.refused = null;
    }
    if (this.hold) {
      this.settleHold(this.hold.accept(event, now));
      // Escape and the hold keys belong to the hold; anything else still acts below.
      if (event.key === "Escape" || event.key === "r" || event.key === "u") return;
    }
    if (event.type !== "press") return;
    if (event.key === "q" || event.key === "\u0003") { this.detach(); return; }
    switch (event.key) {
      case "r": case "u": this.beginHold(event.key, now); break;
      case "d": this.enqueue(() => this.act("daemon")); break;
      case "h": this.enqueue(() => this.act("host")); break;
      case "a": this.enqueue(() => this.act("app")); break;
      case "s": this.enqueue(() => this.act("start")); break;
      case "o": this.enqueue(() => this.act("open")); break;
      default: break;
    }
  }

  private beginHold(key: HoldKey, now: number) {
    const runtime = this.controls?.snapshot().runtime ?? null;
    if (!holdAvailable(key, runtime)) {
      this.refused = new TerminalKeyHold(key, NORMAL_HOLD_MS, now, this.kitty);
      this.notice(key === "r"
        ? operationRunning(runtime) ? "Reload all is unavailable: an update or reload is already running."
          : runtime ? "Reload all is unavailable: nothing needs reloading." : "Reload all is unavailable: the app is not running."
        : runtime?.update?.state === "conflict" ? "Pull changes is unavailable: the update conflicts with local changes."
          : operationRunning(runtime) ? "Pull changes is unavailable: an update or reload is already running."
          : runtime ? "Pull changes is unavailable: no update is available." : "Pull changes is unavailable: the app is not running.");
      return;
    }
    this.hold = new TerminalKeyHold(key, holdDanger(key, runtime) ? DANGER_HOLD_MS : NORMAL_HOLD_MS, now, this.kitty);
    this.stopFrames = (this.options.every ?? ((ms, frame) => {
      const timer = setInterval(frame, ms);
      return () => clearInterval(timer);
    }))(HOLD_FRAME_MS, () => {
      if (this.hold) this.settleHold(this.hold.tick(this.now()));
      this.renderLegend();
    });
    this.renderLegend();
  }

  private settleHold(outcome: HoldOutcome) {
    const hold = this.hold;
    if (!hold || outcome === "holding") return;
    this.endHold();
    if (outcome === "fire") this.enqueue(() => this.act(hold.key === "r" ? "reload" : "pull"));
    this.renderLegend();
  }

  private endHold() {
    this.hold = null;
    this.stopFrames?.();
    this.stopFrames = null;
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

  private async act(kind: "daemon" | "host" | "app" | "start" | "open" | "reload" | "pull") {
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
      } else if (kind === "open") {
        if (!snapshot.app) { this.notice("Open app is unavailable: the app is not running."); return; }
        await controls.openApp();
      } else if (kind === "reload") {
        await controls.reloadAll();
      } else if (kind === "pull") {
        await controls.pullChanges();
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
    this.statusLine.update(renderLegend(snapshot, this.forceArmed, this.hold, this.now()));
  }
}
