/*
 * Exports:
 * - CodexAppServer: stable owner for the Codex app-server stdio process. Keywords: codex, app-server, stdio, lifecycle.
 */
import { spawn, type ChildProcess } from "node:child_process";

import {
    createSpawnOptions,
    getSpawnDescriptor,
    killProcessTree,
    log,
    logError,
    pipeChildStream,
} from "./process-helpers";

export type CodexAppServerOptions = {
  onFatalExit: (reason: string) => void;
  onMessage: (message: unknown) => void;
  projectRoot: string;
};

export default class CodexAppServer {
  private codexProcess: ChildProcess | null = null;
  private readonly onFatalExit: CodexAppServerOptions["onFatalExit"];
  private readonly onMessage: CodexAppServerOptions["onMessage"];
  private readonly projectRoot: string;

  constructor({ onFatalExit, onMessage, projectRoot }: CodexAppServerOptions) {
    this.onFatalExit = onFatalExit;
    this.onMessage = onMessage;
    this.projectRoot = projectRoot;
  }

  send(message: unknown) {
    this.ensureProcess();
    if (!this.codexProcess?.stdin.writable) {
      throw new Error("Codex app-server bridge is not running.");
    }

    this.codexProcess.stdin.write(`${JSON.stringify(message)}\n`);
  }

  stop() {
    if (this.codexProcess && !this.codexProcess.killed) {
      killProcessTree(this.codexProcess.pid);
      this.codexProcess = null;
    }
  }

  private createStdioChild() {
    const spawnDescriptor = getSpawnDescriptor({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
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

    this.codexProcess = this.createStdioChild();
    this.bindStdout(this.codexProcess);
    pipeChildStream("codex-stdio", this.codexProcess.stderr, (chunk) => process.stderr.write(chunk));

    this.codexProcess.once("error", (error) => {
      logError("codex-stdio", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.onFatalExit("Codex app-server failed to start.");
    });

    this.codexProcess.once("exit", (code, signal) => {
      log("codex-stdio", `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.codexProcess = null;
      this.onFatalExit("Codex app-server exited.");
    });

    log("codex-bridge", "started shared stdio app-server");
    return this.codexProcess;
  }

  private bindStdout(codexProcess: ChildProcess) {
    let bufferedOutput = "";

    codexProcess.stdout?.on("data", (chunk: Buffer) => {
      bufferedOutput += chunk.toString("utf8");
      const lines = bufferedOutput.split(/\r?\n/u);
      bufferedOutput = lines.pop() ?? "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          continue;
        }

        try {
          this.onMessage(JSON.parse(trimmedLine) as unknown);
        } catch (error) {
          logError("codex-bridge", `invalid upstream JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }
}
