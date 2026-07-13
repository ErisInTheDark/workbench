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

function sanitizeSessionName(session: string) {
  const sanitized = session.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  const base = sanitized || "default";
  return base === session ? base : `${base}-${createHash("sha256").update(session).digest("hex").slice(0, 8)}`;
}

export default class WorkbenchBrowseDaemonClient {
  private responseSchema: BrowseResponseSchema | null = null;

  async initialize() {
    if (this.responseSchema) return;
    const require = createRequire(__filename);
    const browseBinPath = require.resolve("browse/bin/run.js");
    const browseRequire = createRequire(pathToFileURL(browseBinPath));
    const browseRoot = path.dirname(browseRequire.resolve("browse/package.json"));
    const protocolPath = path.join(browseRoot, "dist", "lib", "driver", "daemon", "protocol.js");
    const protocol = await import(pathToFileURL(protocolPath).href) as { ResponseSchema: BrowseResponseSchema };
    this.responseSchema = protocol.ResponseSchema;
  }

  getRuntimeDirectoryPath() {
    return process.env.BROWSE_DAEMON_DIR?.trim() || path.join(os.tmpdir(), "browse-driver");
  }

  getPidPath(session: string) {
    return path.join(this.getRuntimeDirectoryPath(), `${sanitizeSessionName(session)}.pid`);
  }

  getSocketPath(session: string) {
    const name = sanitizeSessionName(session);
    return process.platform === "win32"
      ? `\\\\.\\pipe\\browse-driver-${name}`
      : path.join(this.getRuntimeDirectoryPath(), `${name}.sock`);
  }

  async listRuntimeSessionNames() {
    let entries;
    try {
      entries = await fs.readdir(this.getRuntimeDirectoryPath(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = new Set<string>();
    for (const entry of entries) {
      const match = entry.isFile() ? /^(.+)\.(?:lock|pid|sock)$/u.exec(entry.name) : null;
      if (match?.[1]) names.add(match[1]);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  async readPid(session: string) {
    try {
      const value = Number.parseInt((await fs.readFile(this.getPidPath(session), "utf8")).trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async cleanupRuntimeFiles(session: string) {
    const name = sanitizeSessionName(session);
    const paths = [
      this.getPidPath(session),
      path.join(this.getRuntimeDirectoryPath(), `${name}.lock`),
      ...(process.platform === "win32" ? [] : [this.getSocketPath(session)]),
    ];
    await Promise.allSettled(paths.map((filePath) => fs.unlink(filePath)));
  }

  async request(session: string, request: WorkbenchBrowseDaemonRequestWithoutId, timeoutMs: number, signal?: AbortSignal) {
    await this.initialize();
    if (signal?.aborted) throw signal.reason;
    const requestWithId = {
      ...request,
      id: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    } as WorkbenchBrowseDaemonRequest;
    return await new Promise<BrowseJsonValue>((resolve, reject) => {
      const socket = net.createConnection(this.getSocketPath(session));
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
}
