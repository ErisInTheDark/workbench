/*
 * Exports:
 * - WorkbenchBridgeRequestControllerOptions: injected harness request dispatcher for deterministic HTTP boundary tests. Keywords: bridge, http, orchestrator, test.
 * - default WorkbenchBridgeRequestController: validate allowlisted server RPC methods and adapt buffered HTTP requests to live harness bridges. Keywords: bridge, http, allowlist, orchestrator, rpc.
 */
import type http from "node:http";

import type { WorkbenchHarness } from "../lib/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

interface BridgeMethodRule {
  harnesses: readonly WorkbenchHarness[];
  method: string;
}

const BRIDGE_METHOD_RULES: readonly BridgeMethodRule[] = [
  { harnesses: ["codex"], method: "workbench/composerProfiles/read" },
  { harnesses: ["codex"], method: "workbench/composerProfiles/importLegacy" },
  { harnesses: ["codex"], method: "workbench/composerProfiles/mutate" },
  { harnesses: ["codex"], method: "thread/context/read" },
  { harnesses: ["codex", "copilot", "opencode"], method: "thread/name/set" },
  { harnesses: ["codex"], method: "workbench/notification/broadcast" },
];

type HarnessRequestDispatcher = (harness: WorkbenchHarness, request: JsonRpcRequest) => Promise<JsonRpcResponse>;

export interface WorkbenchBridgeRequestControllerOptions {
  requestHarness: HarnessRequestDispatcher;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHarness(value: unknown): WorkbenchHarness | null {
  return value === "codex" || value === "copilot" || value === "opencode" ? value : null;
}

function isAllowedMethod(harness: WorkbenchHarness, method: string) {
  return BRIDGE_METHOD_RULES.some((rule) => rule.method === method && rule.harnesses.includes(harness));
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
  const harness = normalizeHarness(body?.harness);
  const request = isRecord(body?.request) ? body.request : null;
  const method = typeof request?.method === "string" ? request.method.trim() : "";
  if (!harness || !request || !method) {
    throw new Error("Workbench bridge requests require a valid harness and method.");
  }
  if (!isAllowedMethod(harness, method)) {
    throw new Error(`Workbench bridge method ${method} is not allowed for ${harness}.`);
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
  private readonly requestHarness: HarnessRequestDispatcher;

  constructor({ requestHarness }: WorkbenchBridgeRequestControllerOptions) {
    this.requestHarness = requestHarness;
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const normalized = normalizeRequestBody(JSON.parse(await readRequestBody(request)) as unknown);
      const bridgeResponse = await this.requestHarness(normalized.harness, normalized.request);
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
