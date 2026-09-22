/*
 * Exports:
 * - default IsolatedWorkbenchProcess: own one scenario process, its evidence and retirement.
 * - IsolatedWorkbenchProcessOptions: inject output observation and shutdown mechanics.
 */
import type { ChildProcess } from "node:child_process";
import { killProcessTreeAsync } from "../../daemon/server/process-helpers";

export interface IsolatedWorkbenchProcessOptions {
  onOutput?: (chunk: Buffer) => void;
  onChange?: () => void;
  gracefulSignal?: () => AbortSignal;
  retire?: (pid: number | undefined) => Promise<void>;
}

export default class IsolatedWorkbenchProcess {
  private tail = "";
  private processError: Error | null = null;
  private retirement: Promise<void> | null = null;

  constructor(
    readonly label: string,
    readonly child: ChildProcess,
    private readonly options: IsolatedWorkbenchProcessOptions = {},
  ) {
    const collect = (chunk: Buffer) => {
      this.tail = (this.tail + chunk.toString()).slice(-12_000);
      options.onOutput?.(chunk);
      options.onChange?.();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", error => {
      this.processError = error;
      options.onChange?.();
    });
    child.once("exit", () => options.onChange?.());
  }

  get pid() { return this.child.pid; }
  get exitCode() { return this.child.exitCode; }
  get exited() { return this.child.exitCode !== null || this.child.signalCode !== null; }
  get evidence() { return `${this.label} pid ${this.pid ?? "unstarted"}\n${this.tail || "(no output captured)"}`; }

  assertRunning() {
    if (this.processError) throw new Error(`${this.evidence}\nProcess failed`, { cause: this.processError });
    if (this.exited) throw new Error(`${this.evidence}\nProcess exited ${this.child.exitCode} (${this.child.signalCode})`);
  }

  stop(force = false) {
    return this.retirement ??= this.retire(force);
  }

  private async retire(force: boolean) {
    try {
      // A failed spawn has no process to retire.
      if (this.exited || this.pid === undefined) return;
      if (force) {
        await this.forceRetire();
        return;
      }
      try {
        await this.closeGracefully();
      } catch (error) {
        // Exit can arrive together with an IPC failure or a deadline.
        if (this.exited) return;
        try {
          await this.forceRetire();
        } catch (retirementError) {
          throw new AggregateError([error, retirementError], `Could not retire ${this.evidence}`);
        }
        throw new Error(`Graceful shutdown failed; force-retired ${this.evidence}`, { cause: error });
      }
    } finally {
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
    }
  }

  private async forceRetire() {
    let exited!: () => void;
    const observedExit = new Promise<void>(resolve => {
      exited = resolve;
      this.child.once("exit", exited);
    });
    try {
      await (this.options.retire ?? killProcessTreeAsync)(this.pid);
      // The platform helper confirms OS retirement. Observe Node's queued exit
      // too before the fixture decides whether it can remove its workspace.
      if (!this.exited) await observedExit;
    } finally {
      this.child.off("exit", exited);
    }
  }

  private async closeGracefully() {
    const controller = new AbortController();
    // This is a shutdown assertion, not a production-work timeout. Failure must
    // retire the child and fail the scenario instead of leaving its runner alive.
    const timer = this.options.gracefulSignal ? null : setTimeout(() => {
      controller.abort(new Error("Scenario graceful shutdown exceeded 45000ms"));
    }, 45_000);
    const signal = this.options.gracefulSignal?.() ?? controller.signal;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let sendError: Error | null = null;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          this.child.off("exit", exited);
          this.child.off("error", failed);
          signal.removeEventListener("abort", aborted);
          if (error) reject(error);
          else resolve();
        };
        const exited = () => finish();
        const failed = (error: Error) => finish(error);
        const aborted = () => finish(sendError
          ? new AggregateError([signal.reason, sendError], "Scenario shutdown did not complete")
          : signal.reason);
        this.child.once("exit", exited);
        this.child.once("error", failed);
        signal.addEventListener("abort", aborted, { once: true });
        if (this.exited) return finish();
        if (signal.aborted) return aborted();
        if (!this.child.connected) {
          sendError = new Error("Scenario shutdown channel disconnected before exit");
          return;
        }
        try {
          // Exit, not the send callback, proves shutdown. Both a blocked send
          // and a child that ignores the request remain covered by the deadline.
          this.child.send({ type: "workbench-scenario-close" }, error => {
            if (error) sendError = error;
          });
        } catch (error) {
          sendError = error instanceof Error ? error : new Error(String(error));
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
