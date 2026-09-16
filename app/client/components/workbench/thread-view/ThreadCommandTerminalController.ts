/*
 * Exports:
 * - TerminalRow: terminal entry plus turn-local one-way expansion intent.
 * - TerminalAnimationBoundary: DOM measurement and animation edge.
 * - default ThreadCommandTerminalController: serialize terminal commits and FLIP motion.
 */
import type { ThreadTerminalEntry } from "./thread-live-activity";

export interface TerminalRow extends ThreadTerminalEntry {
  commandExpanded: boolean;
  outputExpanded: boolean;
}
export interface TerminalAnimationBoundary {
  measure: () => ReadonlyMap<string, number>;
  animate: (before: ReadonlyMap<string, number>) => Array<Pick<Animation, "finished" | "cancel">>;
}

function sameRows(left: readonly TerminalRow[], right: readonly TerminalRow[]) {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]!;
    return row.id === other.id && row.command === other.command && row.output === other.output
      && row.status === other.status && row.streamsOutput === other.streamsOutput
      && row.commandExpanded === other.commandExpanded && row.outputExpanded === other.outputExpanded;
  });
}

export default class ThreadCommandTerminalController {
  private rows: readonly TerminalRow[] = [];
  private desired: readonly TerminalRow[] = [];
  private readonly listeners = new Set<() => void>();
  private phase: "idle" | "committing" | "animating" | "disposed" = "idle";
  private before: ReadonlyMap<string, number> = new Map();
  private batch: ReturnType<TerminalAnimationBoundary["animate"]> | null = null;
  private visible = false;
  private reducedMotion = false;
  private motionFailed = false;

  constructor(private readonly boundary: TerminalAnimationBoundary, private readonly warn = () => console.warn("Terminal animation failed.")) {}

  getSnapshot = () => this.rows;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setEntries(entries: readonly ThreadTerminalEntry[]) {
    if (this.phase === "disposed") return;
    const previous = new Map(this.desired.map(row => [row.id, row]));
    this.desired = entries.map(entry => {
      const old = previous.get(entry.id);
      return {
        ...entry,
        output: entry.status === "inProgress" && entry.streamsOutput && old ? old.output : entry.output,
        commandExpanded: old?.commandExpanded ?? false,
        outputExpanded: old?.outputExpanded ?? false,
      };
    }).sort((left, right) => Number(left.status === "inProgress") - Number(right.status === "inProgress"));
    this.flush();
  }

  setOutput(id: string, output: string) {
    if (this.phase === "disposed") return;
    this.desired = this.desired.map(row => row.id === id && row.status === "inProgress" ? { ...row, output } : row);
    this.flush();
  }

  expand(id: string, field: "command" | "output") {
    if (this.phase === "disposed") return;
    this.desired = this.desired.map(row => row.id === id ? {
      ...row, commandExpanded: row.commandExpanded || field === "command", outputExpanded: row.outputExpanded || field === "output",
    } : row);
    this.flush();
  }

  configure(visible: boolean, reducedMotion: boolean) {
    if (this.phase === "disposed") return;
    this.visible = visible;
    this.reducedMotion = reducedMotion;
    if (!visible || reducedMotion) {
      this.cancelBatch();
      this.phase = "idle";
      this.flush();
    }
  }

  committed() {
    if (this.phase !== "committing") return;
    try {
      const batch = this.boundary.animate(this.before);
      this.batch = batch;
      if (!batch.length) {
        this.phase = "idle";
        this.batch = null;
        this.flush();
        return;
      }
      this.phase = "animating";
      void Promise.all(batch.map(animation => animation.finished)).then(() => {
        if (this.batch !== batch || this.phase === "disposed") return;
        this.cancelBatch();
        this.phase = "idle";
        this.flush();
      }, () => {
        if (this.batch === batch && this.phase !== "disposed") this.fail();
      });
    } catch {
      this.fail();
    }
  }

  dispose() {
    this.phase = "disposed";
    this.cancelBatch();
    this.listeners.clear();
  }

  private flush() {
    if (this.phase !== "idle" || sameRows(this.rows, this.desired)) return;
    const orderChanged = this.rows.length !== this.desired.length
      || this.rows.some((row, index) => row.id !== this.desired[index]?.id);
    const animate = orderChanged && this.visible && !this.reducedMotion && !this.motionFailed && this.rows.length > 0;
    if (animate) {
      try { this.before = this.boundary.measure(); }
      catch { this.fail(); return; }
      this.phase = "committing";
    }
    this.rows = this.desired;
    this.listeners.forEach(listener => listener());
  }

  private cancelBatch() {
    const batch = this.batch;
    this.batch = null;
    batch?.forEach(animation => animation.cancel());
  }

  private fail() {
    this.motionFailed = true;
    this.cancelBatch();
    this.phase = "idle";
    this.warn();
    this.flush();
  }
}
