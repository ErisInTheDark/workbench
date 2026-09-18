/*
 * Exports:
 * - default WorkbenchAppPortRoutes: own bounded app-port HTTP admission and delegate listener lifecycle to the process owner.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  WORKBENCH_APP_PORT_PATH,
  type WorkbenchAppPortUpdateRequest,
} from "workbench-shared/http/workbench-app-port";

import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";

const MAX_REQUEST_BYTES = 1_024;

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readUpdate(request: IncomingMessage): Promise<WorkbenchAppPortUpdateRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Workbench app port request is too large.");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !("port" in value)
    || typeof value.port !== "number"
    || !Number.isSafeInteger(value.port)
    || value.port < 1
    || value.port > 65_535
  ) {
    throw new Error("Workbench app port must be an integer from 1 through 65535.");
  }
  return { port: value.port };
}

function expectedUpdateFailure(error: unknown) {
  if (!(error instanceof Error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE" || code === "EACCES") return "That port is unavailable.";
  if (error.message === "Workbench app port is controlled by WORKBENCH_APP_PORT.") return error.message;
  return null;
}

export default class WorkbenchAppPortRoutes {
  constructor(private readonly options: {
    appPort: WorkbenchAppPortControl;
    onDiagnostic?: (message: string) => void;
    stableOrigin?: (request: IncomingMessage) => string | null;
    canUpdate?: () => boolean;
  }) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname !== WORKBENCH_APP_PORT_PATH) return false;
    if (request.method === "GET") {
      sendJson(response, 200, this.project(this.options.appPort.read(), request, url));
      return true;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { Allow: "GET, PUT" });
      response.end();
      return true;
    }
    try {
      const update = await readUpdate(request);
      if (this.options.canUpdate?.() === false) {
        sendJson(response, 409, { error: "Finish or cancel the pending network settings change first." });
        return true;
      }
      sendJson(response, 200, this.project(await this.options.appPort.update(update.port), request, url));
    } catch (error) {
      const expected = expectedUpdateFailure(error);
      if (expected) {
        sendJson(response, 409, { error: expected });
      } else if (
        error instanceof SyntaxError
        || (error instanceof Error && error.message === "Workbench app port must be an integer from 1 through 65535.")
      ) {
        sendJson(response, 400, { error: "Workbench app port must be an integer from 1 through 65535." });
      } else {
        this.options.onDiagnostic?.(`Workbench app port update failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)}`);
        sendJson(response, 500, { error: "Unable to move the Workbench app to that port." });
      }
    }
    return true;
  }

  private project(snapshot: ReturnType<WorkbenchAppPortControl["read"]>, request: IncomingMessage, url: URL) {
    return url.searchParams.get("version") === "2"
      ? { ...snapshot, stableOrigin: this.options.stableOrigin?.(request) ?? null }
      : snapshot;
  }
}
