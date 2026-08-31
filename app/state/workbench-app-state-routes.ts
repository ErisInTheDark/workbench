/*
 * Exports:
 * - default WorkbenchAppStateRoutes: own the app-state HTTP namespace, bounded JSON admission, and launch redirect. Keywords: app, state, HTTP, routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  workbenchClientStateMutationKinds,
  type WorkbenchClientStateIdentity,
  type WorkbenchClientStateRecord,
} from "workbench-shared/state/workbench-client-state";
import { createWorkbenchProjectHref } from "workbench-shared/navigation/workbench-route-path";

import WorkbenchAppStateController from "./WorkbenchAppStateController.ts";

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Workbench app-state request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default class WorkbenchAppStateRoutes {
  readonly #controller: WorkbenchAppStateController;

  constructor(controller: WorkbenchAppStateController) {
    this.#controller = controller;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname === "/launch" && request.method === "GET") {
      const snapshot = this.#controller.read();
      const target = snapshot.rows.lastLaunchTarget.find((row) => row.deleted === 0);
      response.writeHead(307, {
        "Cache-Control": "private, no-store",
        Location: target ? createWorkbenchProjectHref(target.project_id) : "/",
      });
      response.end();
      return true;
    }
    const isReadRoute = url.pathname === "/api/workbench-client-state";
    const mutationKinds = workbenchClientStateMutationKinds(url.pathname);
    if (!isReadRoute && !mutationKinds) {
      if (!url.pathname.startsWith("/api/workbench-client-state/")) return false;
      sendJson(response, 404, { error: "Unknown Workbench app-state route." });
      return true;
    }
    try {
      if (isReadRoute && request.method === "GET") {
        const rawRevision = url.searchParams.get("sinceRevision");
        const sinceRevision = rawRevision === null ? undefined : Number(rawRevision);
        if (sinceRevision !== undefined && (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0)) {
          sendJson(response, 400, { error: "sinceRevision must be a non-negative integer." });
          return true;
        }
        sendJson(response, 200, this.#controller.read(sinceRevision));
        return true;
      }
      if (mutationKinds && (request.method === "PUT" || request.method === "DELETE")) {
        const value = await readJson(request);
        if (!isRecord(value) || typeof value.kind !== "string" || !mutationKinds.includes(value.kind as never)) {
          sendJson(response, 400, { error: "Workbench app-state mutation is invalid." });
          return true;
        }
        const mutation = request.method === "PUT"
          ? { action: "put" as const, record: value as WorkbenchClientStateRecord }
          : { action: "delete" as const, identity: value as WorkbenchClientStateIdentity };
        sendJson(response, 200, await this.#controller.mutate(mutation));
        return true;
      }
      response.writeHead(405, { Allow: isReadRoute ? "GET" : "DELETE, PUT" });
      response.end();
      return true;
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message.slice(0, 1_000) : "Workbench app-state request failed.",
      });
      return true;
    }
  }
}
