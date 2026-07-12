/*
 * Exports:
 * - runtime/dynamic: keep the public Browse session transport on the Node.js runtime without static caching. Keywords: browse, sessions, api, stateless.
 * - GET: proxy Browse session listing to the orchestrator-owned controller. Keywords: browse, sessions, proxy, orchestrator.
 * - POST: proxy Browse session stop and forget requests to the orchestrator-owned controller. Keywords: browse, sessions, control, proxy.
 */
import type { NextRequest } from "next/server";

import { proxyWorkbenchOrchestratorRequest } from "../../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/browse/sessions", {
    responseMode: "buffer",
    timeoutMs: 5_000,
  });
}

export async function POST(request: NextRequest) {
  return await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/browse/sessions", { responseMode: "buffer" });
}
