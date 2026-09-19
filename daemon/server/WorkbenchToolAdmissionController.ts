/*
 * Exports:
 * - WorkbenchToolAdmissionOptions: bind authoritative identity, policy, approval and execution owners.
 * - default WorkbenchToolAdmissionController: admit one provider tool call without owning pending interactions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchAdmittedExecution, WorkbenchProviderCaller, WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import { isPathWithinRoot } from "./lib/project";

export interface WorkbenchToolAdmissionOptions {
  caller: WorkbenchProviderCaller;
  resolve(signal: AbortSignal): Promise<{
    caller: WorkbenchProviderCaller;
    writableRoots: string[];
    network: boolean;
  }>;
  approve(request: { caller: WorkbenchProviderCaller; command: string[]; cwd: string }, signal: AbortSignal): Promise<boolean>;
  execute: NonNullable<WorkbenchProviderTools["execute"]>;
  canonicalize?: (path: string) => Promise<string>;
}

export default class WorkbenchToolAdmissionController {
  constructor(private readonly options: WorkbenchToolAdmissionOptions) {}

  async execute(input: { command: string[]; cwd?: string; outsideSandbox?: boolean; timeoutMs?: number }, signal: AbortSignal) {
    signal.throwIfAborted();
    const command = [...input.command];
    if (!command.length || !command[0]?.trim() || command.some(arg => arg.includes("\0"))) {
      throw new Error("Tool execution requires a valid command.");
    }
    const outsideSandbox = input.outsideSandbox === true;
    const timeoutMs = input.timeoutMs;
    const requestedCwd = input.cwd;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("A command deadline must be a positive integer.");
    }
    const resolved = await this.options.resolve(signal);
    const caller = { ...resolved.caller };
    if (caller.threadId !== this.options.caller.threadId || caller.harness !== this.options.caller.harness) {
      throw new Error("Tool execution caller no longer matches its provider binding.");
    }
    const canonicalize = this.options.canonicalize ?? fs.realpath;
    const [boundRoot, currentRoot] = await Promise.all([
      canonicalize(this.options.caller.cwd), canonicalize(caller.cwd),
    ]);
    if (!isPathWithinRoot(boundRoot, currentRoot) || !isPathWithinRoot(currentRoot, boundRoot)) {
      throw new Error("Tool execution caller changed its bound working directory.");
    }
    const cwd = await canonicalize(path.resolve(currentRoot, requestedCwd ?? "."));
    if (!isPathWithinRoot(cwd, currentRoot)) throw new Error("Tool working directory is outside its bound project.");
    const writableRoots = await Promise.all(resolved.writableRoots.map(root => canonicalize(root)));
    signal.throwIfAborted();
    let permissions: WorkbenchAdmittedExecution["permissions"] = {
      mode: "restricted", writableRoots, network: resolved.network,
    };
    if (outsideSandbox) {
      const approved = await this.options.approve({ caller: { ...caller }, command: [...command], cwd }, signal);
      signal.throwIfAborted();
      if (!approved) throw new Error("Outside-sandbox execution was declined.");
      permissions = { mode: "approved-unrestricted" };
    }
    signal.throwIfAborted();
    return this.options.execute({ caller, command, cwd, permissions, timeoutMs }, signal);
  }
}
