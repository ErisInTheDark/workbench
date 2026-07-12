/*
 * Exports:
 * - runtime/dynamic: keep the public Browse transport on the Node.js runtime without static caching. Keywords: browse, api, node runtime, stateless.
 * - POST: proxy Browse commands and streamed sequences to the orchestrator-owned controller. Keywords: browse, proxy, orchestrator, streaming.
 */
import type { NextRequest } from "next/server";

import { proxyWorkbenchOrchestratorRequest } from "../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/browse", { responseMode: "stream" });
}
