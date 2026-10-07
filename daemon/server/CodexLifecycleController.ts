/*
 * Exports:
 * - CodexLifecycleControllerOptions: graph restart, generation and logging ports.
 * - default CodexLifecycleController: own native readiness, recover the child process, and stop recovery when it cannot help.
 */
import { createInitializeCapabilities, createInitializeRequest } from "workbench-shared/codex/protocol";
import type CodexStdioBridge from "./CodexStdioBridge";
import CodexRecoverySupervisor from "./CodexRecoverySupervisor";

export interface CodexLifecycleControllerOptions {
  isShuttingDown(): boolean;
  log(message: string): void;
  logError(message: string): void;
  recover(reason: string): Promise<void>;
}

export default class CodexLifecycleController {
  private readonly supervisor: CodexRecoverySupervisor;

  constructor(private readonly options: CodexLifecycleControllerOptions) {
    this.supervisor = new CodexRecoverySupervisor({
      ...options,
      initialRetryDelayMs: 4_000,
      maxRetryDelayMs: 60_000,
    });
  }

  initialize(bridge: Pick<CodexStdioBridge, "ensureInitialized">) {
    return bridge.ensureInitialized(createInitializeRequest(0, {
      capabilities: createInitializeCapabilities({ experimentalApi: true }),
    }));
  }

  async ready(bridge: Pick<CodexStdioBridge, "ensureInitialized" | "beginStopping">) {
    try {
      await this.initialize(bridge);
    } catch (error) {
      if (!this.options.isShuttingDown()) {
        bridge.beginStopping();
        this.requestRecovery(`Codex readiness failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      }
      throw error;
    }
  }

  requestRecovery(reason: string) {
    this.supervisor.requestRecovery(reason);
  }

  /** Recovery cannot help (the executable is missing); a lifecycle reload or daemon restart starts a fresh supervisor. */
  stopRecovery(reason: string) {
    this.supervisor.dispose();
    this.options.logError(`Codex recovery stopped: ${reason}`);
  }

  pause() { this.supervisor.pause(); }
  resume() { this.supervisor.resume(); }
  dispose() { this.supervisor.dispose(); }
}
