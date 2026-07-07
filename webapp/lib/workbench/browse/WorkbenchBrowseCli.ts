/*
 * Exports:
 * - WorkbenchBrowseExecutionContext: resolved cwd and project ownership for a Browse command. Keywords: browse, cwd, project.
 * - default WorkbenchBrowseCli: project-local Browse CLI runner and runtime-dir inspector. Keywords: browse, cli, process, runtime sessions.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appRoot, normalizeRelativePath, resolveProjectRoot } from "../../project";
import type { WorkbenchBrowseCommandRequest, WorkbenchBrowseCommandResponse } from "../../types";
import { resolveAgentEndpointProjectFromCwd } from "../project/agent-endpoint-project";

export interface WorkbenchBrowseExecutionContext {
  cwd: string;
  projectId: string | null;
  projectRootPath: string | null;
}

const DEFAULT_BROWSE_TIMEOUT_MS = 120_000;
const DEFAULT_BROWSE_STATUS_TIMEOUT_MS = 5_000;
const MAX_BROWSE_TIMEOUT_MS = 10 * 60_000;
const BROWSE_RUNTIME_SESSION_FILE_PATTERN = /^(.+)\.(?:lock|pid|sock)$/u;

export default class WorkbenchBrowseCli {
  async listRuntimeSessionNames() {
    const runtimeDirectoryPath = this.getRuntimeDirectoryPath();
    let entries;
    try {
      entries = await fs.readdir(runtimeDirectoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const match = BROWSE_RUNTIME_SESSION_FILE_PATTERN.exec(entry.name);
      if (match?.[1]) {
        sessions.add(match[1]);
      }
    }

    return [...sessions].sort((left, right) => left.localeCompare(right));
  }

  getRuntimeDirectoryPath() {
    return process.env.BROWSE_DAEMON_DIR?.trim()
      || path.join(os.tmpdir(), this.getDefaultRuntimeDirectoryName());
  }

  async readRuntimePid(sessionName: string) {
    const pidPath = path.join(this.getRuntimeDirectoryPath(), `${sessionName}.pid`);
    try {
      const rawPid = await fs.readFile(pidPath, "utf8");
      const pid = Number.parseInt(rawPid.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async resolveExecutionContext(request: Pick<WorkbenchBrowseCommandRequest, "cwd" | "projectId">): Promise<WorkbenchBrowseExecutionContext> {
    if (request.cwd) {
      const resolution = await resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "Browse" });
      return {
        cwd: resolution.cwd,
        projectId: resolution.project.id,
        projectRootPath: normalizeRelativePath(resolution.project.root),
      };
    }

    const project = await resolveProjectRoot(request.projectId);
    return {
      cwd: path.resolve(project.root),
      projectId: project.id,
      projectRootPath: normalizeRelativePath(project.root),
    };
  }

  async run(request: WorkbenchBrowseCommandRequest): Promise<WorkbenchBrowseCommandResponse> {
    const startedAt = Date.now();
    const browseEntrypoint = await this.resolveBrowseEntrypoint();
    const executionContext = await this.resolveExecutionContext(request);
    const timeoutMs = normalizeTimeout(request.timeoutMs, DEFAULT_BROWSE_TIMEOUT_MS);

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [browseEntrypoint, ...request.args], {
        cwd: executionContext.cwd,
        env: {
          ...process.env,
          BROWSERBASE_TELEMETRY_DISABLED: "1",
          BROWSE_DISABLE_UPDATE_CHECK: "1",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          durationMs: Date.now() - startedAt,
          error: error.message,
          exitCode: null,
          ok: false,
          stderr,
          stdout,
          timedOut,
        });
      });
      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          durationMs: Date.now() - startedAt,
          error: timedOut ? `browse command timed out after ${timeoutMs}ms.` : undefined,
          exitCode,
          ok: exitCode === 0 && !timedOut,
          stderr,
          stdout,
          timedOut: timedOut || undefined,
        });
      });

      if (request.stdin) {
        child.stdin.end(request.stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  async runStatus(sessionName: string, request: Pick<WorkbenchBrowseCommandRequest, "cwd" | "projectId" | "threadId">) {
    return await this.run({
      args: ["status", "--session", sessionName],
      cwd: request.cwd ?? null,
      projectId: request.projectId ?? null,
      threadId: request.threadId,
      timeoutMs: DEFAULT_BROWSE_STATUS_TIMEOUT_MS,
    });
  }

  private async resolveBrowseEntrypoint() {
    const entrypoint = path.join(appRoot, "lib", "workbench", "browse", "run-browse-cli.mjs");
    const browseEntrypoint = path.join(appRoot, "node_modules", "browse", "bin", "run.js");
    try {
      await fs.access(entrypoint);
      await fs.access(browseEntrypoint);
    } catch {
      throw new Error("The project-local browse CLI entrypoint was not found. Install the browse dependency in webapp before using /api/browse.");
    }
    return entrypoint;
  }

  private getDefaultRuntimeDirectoryName() {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    return uid === null ? "browse-driver" : `browse-driver-${uid}`;
  }
}

function normalizeTimeout(value: number | null | undefined, fallback: number) {
  const numericValue = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.min(Math.trunc(numericValue), MAX_BROWSE_TIMEOUT_MS);
}
