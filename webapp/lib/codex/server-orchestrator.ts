/*
 * Exports:
 * - WorkbenchServerOrchestratorRequest: allowlisted server RPC request shape forwarded through the orchestrator HTTP boundary. Keywords: orchestrator, http, rpc, contract.
 * - WorkbenchServerOrchestratorRequestOptions: injectable fetch and signal override for deterministic tests and abort-owned cleanup. Keywords: orchestrator, http, fetch, abort, test.
 * - WorkbenchThreadHydrationRequest: Codex-orchestrator transcript window request kept outside browser contracts. Keywords: codex, transcript, hydration, internal.
 * - getServerWorkbenchOrchestratorOrigins: resolve candidate loopback HTTP orchestrator origins for stateless server routes. Keywords: orchestrator, http, server, loopback, fallback.
 * - sendServerWorkbenchOrchestratorRequest: send one buffered allowlisted bridge request to the orchestrator without constructing a WebSocket client. Keywords: orchestrator, http, bridge, rpc, server.
 */
import type { NextRequest } from "next/server";

import {
  DEFAULT_CODEX_APP_SERVER_URL,
  getCodexAppServerPort,
  getCodexAppServerUrl,
} from "./config";
import type { WorkbenchHarness } from "../types";

const ORCHESTRATOR_BRIDGE_REQUEST_PATH = "/orchestrator/bridge-request";

export type WorkbenchThreadHydrationRequest =
  | { mode: "latest" }
  | { beforeTurnId: string; mode: "previous" }
  | { mode: "legacyFull" };

export interface WorkbenchServerOrchestratorRequest {
  method: string;
  params?: object;
  workbenchThreadHydration?: WorkbenchThreadHydrationRequest;
}

export interface WorkbenchServerOrchestratorRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | null;
}

function normalizeWebSocketUrl(url: string) {
  const parsedUrl = new URL(url);
  parsedUrl.pathname = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString().replace(/\/$/u, "");
}

function websocketUrlToHttpOrigin(url: string) {
  const parsedUrl = new URL(normalizeWebSocketUrl(url));
  parsedUrl.protocol = parsedUrl.protocol === "wss:" ? "https:" : "http:";
  return parsedUrl.toString().replace(/\/$/u, "");
}

function tryBuildRequestHostOrchestratorUrl(request: NextRequest) {
  const hostname = request.nextUrl.hostname?.trim();
  return hostname ? normalizeWebSocketUrl(`ws://${hostname}:${getCodexAppServerPort()}`) : null;
}

export function getServerWorkbenchOrchestratorOrigins(request: NextRequest) {
  const candidates = [
    tryBuildRequestHostOrchestratorUrl(request),
    getCodexAppServerUrl().replace("://0.0.0.0", "://127.0.0.1"),
    DEFAULT_CODEX_APP_SERVER_URL,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates.map(websocketUrlToHttpOrigin)));
}

export async function sendServerWorkbenchOrchestratorRequest<TResponse>(
  request: NextRequest,
  harness: WorkbenchHarness,
  bridgeRequest: WorkbenchServerOrchestratorRequest,
  {
    fetchImpl = fetch,
    signal = request.signal,
  }: WorkbenchServerOrchestratorRequestOptions = {},
) {
  let lastNetworkError: Error | null = null;
  for (const origin of getServerWorkbenchOrchestratorOrigins(request)) {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${ORCHESTRATOR_BRIDGE_REQUEST_PATH}`, {
        body: JSON.stringify({ harness, request: bridgeRequest }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      lastNetworkError = error instanceof Error ? error : new Error(String(error));
      if (signal?.aborted) throw lastNetworkError;
      continue;
    }

    const payload = await response.json() as { error?: string; result?: TResponse };
    if (!response.ok) {
      throw new Error(payload.error || "Workbench orchestrator request failed.");
    }
    if (!("result" in payload)) {
      throw new Error("Workbench orchestrator response did not contain a result.");
    }
    return payload.result as TResponse;
  }

  throw lastNetworkError ?? new Error("Unable to reach the Workbench orchestrator.");
}
