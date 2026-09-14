/*
 * Default export:
 * - WorkbenchAppSettingsRoutes: own bounded app-wide settings HTTP admission over shared state and process-applied values.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  WORKBENCH_APP_SETTINGS_PATH,
  type WorkbenchAppSettingsSnapshot,
  type WorkbenchAppSettingsUpdateRequest,
} from "workbench-shared/http/workbench-app-settings";

const MAX_REQUEST_BYTES = 1_024;

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readUpdate(request: IncomingMessage): Promise<WorkbenchAppSettingsUpdateRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Workbench app settings request is too large.");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !("reactDevelopmentMode" in value)
    || typeof value.reactDevelopmentMode !== "boolean"
  ) {
    throw new Error("Workbench app settings request is invalid.");
  }
  return { reactDevelopmentMode: value.reactDevelopmentMode };
}

export default class WorkbenchAppSettingsRoutes {
  constructor(private readonly options: {
    onDiagnostic?: (message: string) => void;
    readAppliedReactDevelopmentMode(): boolean;
    readRequestedReactDevelopmentMode(): boolean | null;
    writeRequestedReactDevelopmentMode(value: boolean): Promise<void>;
  }) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname !== WORKBENCH_APP_SETTINGS_PATH) return false;
    if (request.method === "GET") {
      sendJson(response, 200, this.snapshot());
      return true;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { Allow: "GET, PUT" });
      response.end();
      return true;
    }
    try {
      const update = await readUpdate(request);
      await this.options.writeRequestedReactDevelopmentMode(update.reactDevelopmentMode);
      sendJson(response, 200, this.snapshot());
    } catch (error) {
      if (
        error instanceof SyntaxError
        || (error instanceof Error && (
          error.message === "Workbench app settings request is invalid."
          || error.message === "Workbench app settings request is too large."
        ))
      ) {
        sendJson(response, 400, { error: "Workbench app settings request is invalid." });
      } else {
        this.options.onDiagnostic?.(
          `Workbench app settings update failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)}`,
        );
        sendJson(response, 500, { error: "Unable to save Workbench app settings." });
      }
    }
    return true;
  }

  private snapshot(): WorkbenchAppSettingsSnapshot {
    return {
      appliedReactDevelopmentMode: this.options.readAppliedReactDevelopmentMode(),
      requestedReactDevelopmentMode: this.options.readRequestedReactDevelopmentMode() === true,
    };
  }
}
