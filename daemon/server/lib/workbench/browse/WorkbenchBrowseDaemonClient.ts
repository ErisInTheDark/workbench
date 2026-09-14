/*
 * Exports:
 * - WorkbenchBrowseDaemonRequest/WorkbenchBrowseDaemonRequestWithoutId/WorkbenchBrowseDaemonResponse: narrow Browse daemon protocol contracts. Keywords: browse, daemon, protocol, socket.
 * - WorkbenchBrowseDaemonTimeoutError: identify runtime-owned deadline failures that require session retirement. Keywords: browse, timeout, session, failure.
 * - default WorkbenchBrowseDaemonClient: import Browse protocol validation once and execute abortable named-pipe requests. Keywords: browse, daemon, client, cancellation.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import type { BrowseJsonValue } from "./actions/session-actions";

export type WorkbenchBrowseDaemonRequest =
  | { id: string; type: "status" | "stop" }
  | { id: string; timeoutMs?: number; type: "open"; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" }
  | { command: string; id: string; params: { [key: string]: BrowseJsonValue | undefined }; type: "command" };

export type WorkbenchBrowseDaemonRequestWithoutId =
  WorkbenchBrowseDaemonRequest extends infer TRequest
    ? TRequest extends WorkbenchBrowseDaemonRequest
      ? Omit<TRequest, "id">
      : never
    : never;

export type WorkbenchBrowseDaemonResponse =
  | { data: BrowseJsonValue; id: string; type: "success" }
  | { code?: string; error: string; httpStatus?: number; id?: string; type: "error" };

interface BrowseResponseSchema {
  parse(value: object): WorkbenchBrowseDaemonResponse;
}

export class WorkbenchBrowseDaemonTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchBrowseDaemonTimeoutError";
  }
}

interface WorkbenchBrowseDaemonClientOptions {
  legacyRuntimeDirectoryPath?: string;
  runtimeDirectoryPath?: string;
}

function sanitizeSessionName(session: string) {
  const sanitized = session.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  const base = sanitized || "default";
  return base === session ? base : `${base}-${createHash("sha256").update(session).digest("hex").slice(0, 8)}`;
}

export default class WorkbenchBrowseDaemonClient {
  private readonly legacyRuntimeDirectoryPath: string;
  private responseSchema: BrowseResponseSchema | null = null;
  private readonly runtimeDirectoryPath: string;

  constructor(options: WorkbenchBrowseDaemonClientOptions = {}) {
    this.runtimeDirectoryPath = options.runtimeDirectoryPath
      ?? process.env.BROWSE_DAEMON_DIR?.trim()
      ?? WorkbenchTemporaryDirectory.resolve("browse-driver");
    this.legacyRuntimeDirectoryPath = options.legacyRuntimeDirectoryPath
      ?? path.join(os.tmpdir(), "browse-driver");
  }

  async initialize() {
    if (this.responseSchema) return;
    await fs.mkdir(this.runtimeDirectoryPath, { recursive: true });
    const require = createRequire(__filename);
    const browseBinPath = require.resolve("browse/bin/run.js");
    const browseRequire = createRequire(pathToFileURL(browseBinPath));
    const browseRoot = path.dirname(browseRequire.resolve("browse/package.json"));
    const protocolPath = path.join(browseRoot, "dist", "lib", "driver", "daemon", "protocol.js");
    const protocol = await import(pathToFileURL(protocolPath).href) as { ResponseSchema: BrowseResponseSchema };
    this.responseSchema = protocol.ResponseSchema;
  }

  getRuntimeDirectoryPath() {
    return this.runtimeDirectoryPath;
  }

  getRuntimeDirectoryPaths() {
    return pathsEqual(this.runtimeDirectoryPath, this.legacyRuntimeDirectoryPath)
      ? [this.runtimeDirectoryPath]
      : [this.runtimeDirectoryPath, this.legacyRuntimeDirectoryPath];
  }

  getPidPath(session: string, runtimeDirectoryPath = this.runtimeDirectoryPath) {
    return path.join(runtimeDirectoryPath, `${sanitizeSessionName(session)}.pid`);
  }

  getSocketPath(session: string, runtimeDirectoryPath = this.runtimeDirectoryPath) {
    const name = sanitizeSessionName(session);
    return process.platform === "win32"
      ? `\\\\.\\pipe\\browse-driver-${name}`
      : path.join(runtimeDirectoryPath, `${name}.sock`);
  }

  async listRuntimeSessionNames() {
    const names = new Set<string>();
    for (const runtimeDirectoryPath of this.getRuntimeDirectoryPaths()) {
      let entries;
      try {
        entries = await fs.readdir(runtimeDirectoryPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const match = entry.isFile() ? /^(.+)\.(?:lock|pid|sock)$/u.exec(entry.name) : null;
        if (match?.[1]) names.add(match[1]);
      }
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  async readPid(session: string) {
    for (const runtimeDirectoryPath of this.getRuntimeDirectoryPaths()) {
      try {
        const value = Number.parseInt((await fs.readFile(this.getPidPath(session, runtimeDirectoryPath), "utf8")).trim(), 10);
        if (Number.isInteger(value) && value > 0) return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return null;
  }

  async cleanupRuntimeFiles(session: string) {
    const name = sanitizeSessionName(session);
    const paths = this.getRuntimeDirectoryPaths().flatMap((runtimeDirectoryPath) => [
      this.getPidPath(session, runtimeDirectoryPath),
      path.join(runtimeDirectoryPath, `${name}.lock`),
      ...(process.platform === "win32" ? [] : [this.getSocketPath(session, runtimeDirectoryPath)]),
    ]);
    await Promise.allSettled(paths.map((filePath) => fs.unlink(filePath)));
  }

  async request(session: string, request: WorkbenchBrowseDaemonRequestWithoutId, timeoutMs: number, signal?: AbortSignal) {
    await this.initialize();
    if (signal?.aborted) throw signal.reason;
    const requestWithId = {
      ...request,
      id: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    } as WorkbenchBrowseDaemonRequest;
    const runtimeDirectoryPath = await this.resolveRuntimeDirectoryPath(session);
    return await new Promise<BrowseJsonValue>((resolve, reject) => {
      const socket = net.createConnection(this.getSocketPath(session, runtimeDirectoryPath));
      let buffer = "";
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        operation();
      };
      const fail = (error: Error) => finish(() => reject(error));
      const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("Browse request cancelled."));
      const timer = setTimeout(() => fail(new WorkbenchBrowseDaemonTimeoutError(`Browse session ${session} timed out after ${timeoutMs}ms.`)), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => socket.write(`${JSON.stringify(requestWithId)}\n`));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0 || !this.responseSchema) return;
        try {
          const response = this.responseSchema.parse(JSON.parse(buffer.slice(0, newline)) as object);
          if (response.type === "error") {
            fail(new Error(response.error));
          } else {
            finish(() => resolve(response.data));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new Error(`Browse daemon session ${session} closed without a complete response.`));
      });
    });
  }

  private async resolveRuntimeDirectoryPath(session: string) {
    for (const runtimeDirectoryPath of this.getRuntimeDirectoryPaths()) {
      try {
        await fs.access(this.getPidPath(session, runtimeDirectoryPath));
        return runtimeDirectoryPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return this.runtimeDirectoryPath;
  }
}

function pathsEqual(left: string, right: string) {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
