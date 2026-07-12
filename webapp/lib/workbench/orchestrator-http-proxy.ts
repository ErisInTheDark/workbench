/*
 * Exports:
 * - WorkbenchOrchestratorProxyOptions: select buffered versus streamed upstream responses and an optional total timeout. Keywords: orchestrator, proxy, buffering, timeout.
 * - proxyWorkbenchOrchestratorRequest: forward a stateless Next route request to the local orchestrator while preserving status, content type, cancellation, and the selected response mode. Keywords: orchestrator, proxy, next route, streaming, loopback.
 */
import type { NextRequest } from "next/server";

import { getServerCodexBridgeHttpOrigins } from "../codex/server-bridge";

export interface WorkbenchOrchestratorProxyOptions {
  responseMode: "buffer" | "stream";
  timeoutMs?: number;
}

export async function proxyWorkbenchOrchestratorRequest(
  request: NextRequest,
  pathname: string,
  options: WorkbenchOrchestratorProxyOptions,
) {
  const requestBody = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.arrayBuffer();
  const suffix = request.nextUrl.search;
  let lastError: Error | null = null;
  const timeoutController = options.timeoutMs ? new AbortController() : null;
  const timeout = options.timeoutMs
    ? setTimeout(() => timeoutController?.abort(new Error("Workbench orchestrator request timed out.")), options.timeoutMs)
    : null;
  const signal = timeoutController
    ? AbortSignal.any([request.signal, timeoutController.signal])
    : request.signal;

  try {
    for (const origin of getServerCodexBridgeHttpOrigins(request)) {
      try {
        const upstream = await fetch(`${origin}${pathname}${suffix}`, {
          body: requestBody,
          cache: "no-store",
          headers: {
            "Content-Type": request.headers.get("content-type") ?? "application/json",
          },
          method: request.method,
          redirect: "error",
          signal,
        });
        const body = options.responseMode === "buffer"
          ? await upstream.arrayBuffer()
          : upstream.body;
        return new Response(body, {
          headers: upstream.headers,
          status: upstream.status,
          statusText: upstream.statusText,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return Response.json({
    error: lastError?.message ?? "Unable to reach the Workbench orchestrator.",
  }, {
    headers: { "Cache-Control": "no-store" },
    status: 502,
  });
}
