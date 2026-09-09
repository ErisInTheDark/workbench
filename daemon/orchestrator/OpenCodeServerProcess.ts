/*
 * Keywords: OpenCode, CLI, readiness, child ownership, force retirement.
 * Exports:
 * - OpenCodeServerProcessOptions: SDK-compatible launch inputs and owned process ports.
 * - OpenCodeManagedProcess: readiness and confirmed closure contract.
 * - default OpenCodeServerProcess: retain a managed child before readiness and through closure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { createSpawnOptions, getSpawnDescriptor, killProcessTreeAsync } from "./process-helpers";

export interface OpenCodeManagedProcess {
  start(): Promise<string>;
  close(): Promise<void>;
}

export type OpenCodeServerProcessOptions = NonNullable<Parameters<typeof createOpencodeServer>[0]> & {
  environment?: NodeJS.ProcessEnv;
  createChild?: () => ChildProcess;
  terminateChild?: (child: ChildProcess) => Promise<void>;
};

export default class OpenCodeServerProcess implements OpenCodeManagedProcess {
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private retirement: Promise<void> | null = null;
  private closeRequested = false;

  constructor(private readonly options: OpenCodeServerProcessOptions) {}

  start() {
    if (this.closeRequested) return Promise.reject(new Error("OpenCode process has been closed."));
    if (this.starting) return this.starting;
    this.starting = this.startChild();
    return this.starting;
  }

  private async startChild() {
    this.options.signal?.throwIfAborted();
    const args = ["serve", `--hostname=${this.options.hostname ?? "127.0.0.1"}`, `--port=${this.options.port ?? 4096}`];
    if (this.options.config?.logLevel) args.push(`--log-level=${this.options.config.logLevel}`);
    const descriptor = getSpawnDescriptor({ command: "opencode", args });
    const child = this.options.createChild?.() ?? spawn(descriptor.command, descriptor.args, {
      ...createSpawnOptions(process.cwd(), {
        ...this.options.environment ?? process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(this.options.config ?? {}),
      }, true),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    try {
      return await new Promise<string>((resolve, reject) => {
        let output = "";
        let lines = "";
        const timeout = setTimeout(() => fail(new Error(`Timeout waiting for OpenCode server after ${this.options.timeout ?? 5000}ms`)),
          this.options.timeout ?? 5000);
        const clear = () => {
          clearTimeout(timeout);
          child.stdout?.off("data", stdout);
          child.stderr?.off("data", stderr);
          child.off("error", fail);
          child.off("exit", exit);
          this.options.signal?.removeEventListener("abort", abort);
        };
        const fail = (error: Error) => { clear(); reject(error); };
        const abort = () => fail(this.options.signal!.reason);
        const exit = (code: number | null) => fail(new Error(`OpenCode server exited with code ${code}\n${output}`));
        const stderr = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
        const stdout = (chunk: Buffer) => {
          stderr(chunk);
          lines = (lines + chunk.toString()).slice(-8000);
          const complete = lines.split(/\r?\n/u);
          lines = complete.pop() ?? "";
          for (const line of complete) {
            if (!line.startsWith("opencode server listening")) continue;
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/u);
            if (!match) { fail(new Error("Failed to parse OpenCode server readiness URL.")); return; }
            clear();
            resolve(match[1]);
            return;
          }
        };
        child.stdout?.on("data", stdout);
        child.stderr?.on("data", stderr);
        child.once("error", fail);
        child.once("exit", exit);
        this.options.signal?.addEventListener("abort", abort, { once: true });
        if (this.options.signal?.aborted) abort();
      });
    } catch (error) {
      try { await this.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], "OpenCode startup and retirement failed."); }
      throw error;
    }
  }

  close() {
    this.closeRequested = true;
    if (this.retirement) return this.retirement;
    const child = this.child;
    if (!child?.pid) return Promise.resolve();
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit").then(() => undefined);
    // Install observation before signalling; an immediately exiting child is still owned.
    void exited.catch(() => {});
    const retirement = (async () => {
      await (this.options.terminateChild ?? (async owned => await killProcessTreeAsync(owned.pid)))(child);
      await exited;
      if (this.child === child) this.child = null;
    })();
    this.retirement = retirement;
    void retirement.catch(() => {
      if (this.retirement === retirement) this.retirement = null;
    });
    return retirement;
  }
}
