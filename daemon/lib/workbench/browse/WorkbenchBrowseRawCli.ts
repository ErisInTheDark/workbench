/*
 * Exports:
 * - default WorkbenchBrowseRawCli: execute explicitly enabled raw Browse CLI compatibility commands in an isolated child process. Keywords: browse, raw, cli, process, compatibility.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { appRoot } from "../../project";
import type { WorkbenchBrowseCommandRequest, WorkbenchBrowseCommandResponse } from "workbench-shared/types";
import { killProcessTree } from "../../../orchestrator/process-helpers";
import WorkbenchBrowseProfileStore from "./WorkbenchBrowseProfileStore";
import type WorkbenchBrowseRuntime from "./WorkbenchBrowseRuntime";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export default class WorkbenchBrowseRawCli {
  constructor(
    private readonly runtime: Pick<WorkbenchBrowseRuntime, "resolveExecutionContext">,
    private readonly profileStore = new WorkbenchBrowseProfileStore(),
  ) {}

  async run(request: WorkbenchBrowseCommandRequest, signal?: AbortSignal): Promise<WorkbenchBrowseCommandResponse> {
    const startedAt = Date.now();
    const entrypoint = path.join(appRoot, "lib", "workbench", "browse", "run-browse-cli.mjs");
    await fs.access(entrypoint).catch(() => { throw new Error("The project-local Browse CLI entrypoint was not found."); });
    const execution = await this.runtime.resolveExecutionContext(request);
    const timeoutMs = normalizeTimeout(request.timeoutMs);
    const prepared = await this.prepareCommand(request.args);
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [entrypoint, ...prepared.args], {
        cwd: execution.cwd,
        env: {
          ...process.env,
          BROWSERBASE_TELEMETRY_DISABLED: "1",
          BROWSE_DISABLE_UPDATE_CHECK: "1",
          WORKBENCH_BROWSE_DOWNLOADS_PATH: execution.cwd,
          ...(prepared.profilePath ? { WORKBENCH_BROWSE_USER_DATA_DIR: prepared.profilePath } : {}),
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let aborted = signal?.aborted ?? false;
      let timedOut = false;
      let settled = false;
      const finish = (result: WorkbenchBrowseCommandResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
        aborted = true;
        killProcessTree(child.pid);
        finish({
          durationMs: Date.now() - startedAt,
          error: "Raw Browse command cancelled.",
          exitCode: null,
          ok: false,
          stderr,
          stdout,
        });
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
        finish({
          durationMs: Date.now() - startedAt,
          error: `Raw Browse command timed out after ${timeoutMs}ms.`,
          exitCode: null,
          ok: false,
          stderr,
          stdout,
          timedOut: true,
        });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => finish({
        durationMs: Date.now() - startedAt,
        error: aborted ? "Raw Browse command cancelled." : error.message,
        exitCode: null,
        ok: false,
        stderr,
        stdout,
        timedOut: timedOut || undefined,
      }));
      child.once("close", (exitCode) => finish({
        durationMs: Date.now() - startedAt,
        error: aborted ? "Raw Browse command cancelled." : timedOut ? `Raw Browse command timed out after ${timeoutMs}ms.` : undefined,
        exitCode,
        ok: exitCode === 0 && !timedOut && !aborted,
        stderr,
        stdout,
        timedOut: timedOut || undefined,
      }));
      if (aborted) abort();
      child.stdin.end(request.stdin ?? undefined);
    });
  }

  private async prepareCommand(args: string[]) {
    let persistent = false;
    const preparedArgs = args.filter((arg) => {
      if (arg !== "--persistent") return true;
      persistent = true;
      return false;
    });
    const sessionIndex = preparedArgs.findIndex((arg) => arg === "--session" || arg === "-s");
    const sessionName = sessionIndex >= 0 ? preparedArgs[sessionIndex + 1]?.trim() || null : null;
    return {
      args: preparedArgs,
      profilePath: await this.profileStore.resolveProfilePath({ persistent, sessionName }),
    };
  }
}

function normalizeTimeout(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}
