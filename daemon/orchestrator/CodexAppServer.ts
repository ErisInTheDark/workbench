/*
 * Exports:
 * - CodexAppServerOptions: inject app-server callbacks and testable child lifecycle boundaries. Keywords: codex, app-server, options.
 * - getCodexAppServerArgs: define managed Codex feature policy and app-server stdio arguments. Keywords: codex, app-server, args, policy.
 * - default CodexAppServer: stable owner for the Codex app-server stdio process. Keywords: codex, app-server, stdio, lifecycle.
 */
import { spawn, type ChildProcess } from "node:child_process";

import {
    createSpawnOptions,
    getSpawnDescriptor,
    killProcessTree,
    killProcessTreeAsync,
    log,
    logError,
    pipeChildStream,
} from "./process-helpers";

export type CodexAppServerOptions = {
  createChild?: () => ChildProcess;
  log?: (name: string, message: string) => void;
  logError?: (name: string, message: string) => void;
  onFatalExit: (reason: string) => void;
  onMessage: (message: unknown) => void;
  projectRoot: string;
  terminateChild?: (child: ChildProcess) => void;
  terminateChildAsync?: (child: ChildProcess) => Promise<void>;
};

export function getCodexAppServerArgs() {
  return [
    "--config",
    "skills.include_instructions=false",
    "--config",
    "include_apps_instructions=false",
    "--config",
    "include_collaboration_mode_instructions=false",
    "--config",
    "features.apps=false",
    "--config",
    "features.plugins=false",
    "--config",
    "features.multi_agent=false",
    "--config",
    "features.multi_agent_v2=false",
    "--config",
    "agents.enabled=false",
    "--config",
    "features.apply_patch_streaming_events=true",
    "--config",
    "features.code_mode.direct_only_tool_namespaces=['functions']",
    "--config",
    "hooks.PreToolUse=[{matcher='^apply_patch$',hooks=[{type='command',command='wb __hook apply-patch-claim'}]}]",
    "app-server",
    "--listen",
    "stdio://",
  ];
}

export default class CodexAppServer {
  private codexProcess: ChildProcess | null = null;
  private generation = 0;
  private readonly createChild: () => ChildProcess;
  private readonly log: NonNullable<CodexAppServerOptions["log"]>;
  private readonly logError: NonNullable<CodexAppServerOptions["logError"]>;
  private readonly onFatalExit: CodexAppServerOptions["onFatalExit"];
  private readonly onMessage: CodexAppServerOptions["onMessage"];
  private readonly projectRoot: string;
  private readonly terminateChild: (child: ChildProcess) => void;
  private readonly terminateChildAsync: (child: ChildProcess) => Promise<void>;

  constructor({ createChild, log: lifecycleLog, logError: lifecycleLogError, onFatalExit, onMessage, projectRoot, terminateChild, terminateChildAsync }: CodexAppServerOptions) {
    this.createChild = createChild ?? (() => this.createStdioChild());
    this.log = lifecycleLog ?? log;
    this.logError = lifecycleLogError ?? logError;
    this.onFatalExit = onFatalExit;
    this.onMessage = onMessage;
    this.projectRoot = projectRoot;
    this.terminateChild = terminateChild ?? ((child) => killProcessTree(child.pid));
    this.terminateChildAsync = terminateChildAsync ?? (async (child) => await killProcessTreeAsync(child.pid));
  }

  send(message: unknown) {
    this.ensureProcess();
    if (!this.codexProcess?.stdin.writable) {
      throw new Error("Codex app-server bridge is not running.");
    }

    this.codexProcess.stdin.write(`${JSON.stringify(message)}\n`);
  }

  stop() {
    const retiringProcess = this.detachProcess();
    if (retiringProcess && !retiringProcess.killed) this.terminateChild(retiringProcess);
  }

  async stopAsync() {
    const retiringProcess = this.detachProcess();
    if (retiringProcess && !retiringProcess.killed) await this.terminateChildAsync(retiringProcess);
  }

  private detachProcess() {
    const retiringProcess = this.codexProcess;
    if (!retiringProcess) return null;
    this.codexProcess = null;
    this.generation += 1;
    return retiringProcess;
  }

  private createStdioChild() {
    const spawnDescriptor = getSpawnDescriptor({
      command: "codex",
      args: getCodexAppServerArgs(),
    });

    return spawn(spawnDescriptor.command, spawnDescriptor.args, {
      ...createSpawnOptions(this.projectRoot, {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      }, true),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private ensureProcess() {
    if (this.codexProcess && !this.codexProcess.killed) {
      return this.codexProcess;
    }

    const generation = this.generation + 1;
    const codexProcess = this.createChild();
    this.generation = generation;
    this.codexProcess = codexProcess;
    this.bindStdout(codexProcess, generation);
    pipeChildStream("codex-stdio", codexProcess.stderr, (chunk) => process.stderr.write(chunk));

    codexProcess.once("error", (error) => {
      if (!this.owns(codexProcess, generation)) return;
      this.codexProcess = null;
      this.generation += 1;
      this.logError("codex-stdio", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.onFatalExit("Codex app-server failed to start.");
    });

    codexProcess.once("exit", (code, signal) => {
      this.log("codex-stdio", `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      if (!this.owns(codexProcess, generation)) return;
      this.codexProcess = null;
      this.onFatalExit("Codex app-server exited.");
    });

    this.log("codex-stdio", "launched app-server child; awaiting protocol initialization");
    return codexProcess;
  }

  private owns(codexProcess: ChildProcess, generation: number) {
    return this.codexProcess === codexProcess && this.generation === generation;
  }

  private bindStdout(codexProcess: ChildProcess, generation: number) {
    let bufferedOutput = "";

    codexProcess.stdout?.on("data", (chunk: Buffer) => {
      bufferedOutput += chunk.toString("utf8");
      const lines = bufferedOutput.split(/\r?\n/u);
      bufferedOutput = lines.pop() ?? "";

      for (const line of lines) {
        if (!this.owns(codexProcess, generation)) return;
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          continue;
        }

        try {
          this.onMessage(JSON.parse(trimmedLine) as unknown);
        } catch (error) {
          this.logError("codex-bridge", `invalid upstream JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }
}
