/*
 * Exports:
 * - getServerCodexBridgeUrls: resolve candidate websocket bridge URLs for server-side callers, preferring the current request host and then falling back to loopback-safe local defaults. Keywords: codex, websocket, server, bridge, host, fallback.
 * - getServerCodexBridgeHttpOrigins: resolve candidate HTTP bridge origins for server-side callers, matching the websocket fallback order. Keywords: codex, http, server, bridge, origin.
 * - sendServerWorkbenchBridgeRequest: connect to the local bridge from a server context and send a harness-scoped JSON-RPC request with host-first fallback. Keywords: codex, websocket, bridge, server, request, harness.
 */
import type { NextRequest } from "next/server";

import type { WorkbenchHarness } from "../types";
import { CodexAppServerClient } from "./app-server-client";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  getCodexAppServerPort,
  getCodexAppServerUrl,
} from "./config";
import { isCodexJsonRpcFailure } from "./protocol";

function normalizeWebSocketUrl(url: string) {
  const parsedUrl = new URL(url);
  parsedUrl.pathname = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString().replace(/\/$/, "");
}

function websocketUrlToHttpOrigin(url: string) {
  const parsedUrl = new URL(normalizeWebSocketUrl(url));
  parsedUrl.protocol = parsedUrl.protocol === "wss:" ? "https:" : "http:";
  return parsedUrl.toString().replace(/\/$/, "");
}

function tryBuildRequestHostBridgeUrl(request: NextRequest) {
  const hostname = request.nextUrl.hostname?.trim();
  if (!hostname) {
    return null;
  }

  return normalizeWebSocketUrl(`ws://${hostname}:${getCodexAppServerPort()}`);
}

export function getServerCodexBridgeUrls(request: NextRequest) {
  const candidates = [
    tryBuildRequestHostBridgeUrl(request),
    getCodexAppServerUrl().replace("://0.0.0.0", "://127.0.0.1"),
    DEFAULT_CODEX_APP_SERVER_URL,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates.map(normalizeWebSocketUrl)));
}

export function getServerCodexBridgeHttpOrigins(request: NextRequest) {
  return Array.from(new Set(getServerCodexBridgeUrls(request).map(websocketUrlToHttpOrigin)));
}

export async function sendServerWorkbenchBridgeRequest<TResponse>(
  request: NextRequest,
  harness: WorkbenchHarness,
  bridgeRequest: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
) {
  const candidateUrls = getServerCodexBridgeUrls(request);
  let lastError: unknown = null;

  for (let index = 0; index < candidateUrls.length; index += 1) {
    const candidateUrl = candidateUrls[index];
    const client = new CodexAppServerClient();

    try {
      await client.connect(candidateUrl);
      const response = await client.sendRequest<TResponse>({
        ...bridgeRequest,
        workbenchHarness: harness,
      });
      if (isCodexJsonRpcFailure(response)) {
        const detail = response.error.data ? ` ${JSON.stringify(response.error.data)}` : "";
        throw new Error(`${response.error.message}${detail}`);
      }

      client.close();
      return response.result;
    } catch (error) {
      lastError = error;
      client.close();
      if (index === candidateUrls.length - 1) {
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to reach the local Codex bridge.");
}
