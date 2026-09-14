/*
 * Exports:
 * - WorkbenchBridgeRequestControllerOptions: injected harness controller port for deterministic HTTP boundary tests.
 * - default WorkbenchBridgeRequestController: validate allowlisted server RPC methods and adapt buffered HTTP requests to live harness bridges.
 */
import type http from "node:http";

import type { JsonRpcRequest } from "./bridge-types";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export interface WorkbenchBridgeRequestControllerOptions {
  harnesses: Pick<WorkbenchHarnessController, "requestServer">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readRequestBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error("Workbench bridge request is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: object) {
  const serialized = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(serialized),
    "Content-Type": "application/json",
  });
  response.end(serialized);
}

function normalizeRequestBody(value: unknown) {
  const body = isRecord(value) ? value : null;
  const harness = body?.harness;
  const request = isRecord(body?.request) ? body.request : null;
  const method = typeof request?.method === "string" ? request.method.trim() : "";
  if (typeof harness !== "string" || !harness || !request || !method) {
    throw new Error("Workbench bridge requests require a valid harness and method.");
  }
  return {
    harness,
    request: {
      ...request,
      id: 0,
      method,
    } as JsonRpcRequest,
  };
}

export default class WorkbenchBridgeRequestController {
  private readonly harnesses: Pick<WorkbenchHarnessController, "requestServer">;

  constructor({ harnesses }: WorkbenchBridgeRequestControllerOptions) {
    this.harnesses = harnesses;
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const normalized = normalizeRequestBody(JSON.parse(await readRequestBody(request)) as unknown);
      const bridgeResponse = await this.harnesses.requestServer(normalized.harness, normalized.request);
      if (bridgeResponse.error) {
        sendJson(response, 400, {
          error: bridgeResponse.error.message,
          ...(bridgeResponse.error.code !== undefined ? { code: bridgeResponse.error.code } : {}),
          ...(bridgeResponse.error.data !== undefined ? { data: bridgeResponse.error.data } : {}),
        });
        return;
      }
      sendJson(response, 200, { result: bridgeResponse.result });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Workbench bridge request failed.",
      });
    }
  }
}
