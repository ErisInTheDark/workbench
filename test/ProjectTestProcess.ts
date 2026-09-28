/*
 * Exports:
 * - ProjectTestProcessResult: one owned test-file process outcome.
 * - ProjectTestProcessOptions: parent deadline, cancellation and retirement ports.
 * - default ProjectTestProcess: enforce test-file completion outside the worker event loop.
 */
import type { ChildProcess } from "node:child_process";
import { killProcessTreeAsync } from "../daemon/server/process-helpers";

export interface ProjectTestProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProjectTestProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  retire?: (pid: number | undefined) => Promise<void>;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  report?: (message: string) => void;
}

export default class ProjectTestProcess {
  constructor(
    private readonly child: ChildProcess,
    private readonly file: string,
    private readonly options: ProjectTestProcessOptions,
  ) {}

  wait(): Promise<ProjectTestProcessResult> {
    const { child, options } = this;
    return new Promise((resolve, reject) => {
      let finished = false;
      let retiring = false;
      let cancelDeadline = () => {};
      const clean = () => {
        cancelDeadline();
        options.signal?.removeEventListener("abort", cancelled);
        child.removeListener("exit", exited);
        child.removeListener("error", failed);
      };
      const finish = (result: ProjectTestProcessResult, error?: Error) => {
        if (finished) return;
        finished = true;
        clean();
        if (error) reject(error);
        else resolve(result);
      };
      const retire = (reason: "deadline" | "cancelled") => {
        if (finished || retiring) return;
        retiring = true;
        cancelDeadline();
        options.report?.(`FAIL ${this.file}: ${reason === "deadline"
          ? `test process exceeded ${options.timeoutMs}ms` : "test run cancelled"}; retiring owned pid ${child.pid ?? "unstarted"}.`);
        void (options.retire ?? killProcessTreeAsync)(child.pid).then(
          () => finish({ exitCode: reason === "cancelled" ? 130 : 1, signal: null }),
          cause => finish({ exitCode: 1, signal: null }, new Error(
            `Could not retire test process ${this.file} (pid ${child.pid ?? "unstarted"}).`, { cause })),
        );
      };
      const cancelled = () => retire("cancelled");
      const exited = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (!retiring) finish({ exitCode, signal });
      };
      const failed = (error: Error) => {
        if (!retiring) finish({ exitCode: 1, signal: null }, error);
      };
      child.once("exit", exited);
      child.once("error", failed);
      options.signal?.addEventListener("abort", cancelled, { once: true });
      cancelDeadline = (options.schedule ?? ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      }))(() => retire("deadline"), options.timeoutMs);
      if (options.signal?.aborted) cancelled();
      else if (child.exitCode !== null || child.signalCode !== null) {
        exited(child.exitCode, child.signalCode);
      }
    });
  }
}
