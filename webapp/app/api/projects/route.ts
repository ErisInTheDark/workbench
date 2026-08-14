/*
 * Exports:
 * - runtime/dynamic: keep project-catalog reads on a dynamic Node.js transport route. Keywords: projects, api, node runtime, stateless.
 * - GET: stream the orchestrator-owned serialized project list with caller-owned cancellation. Keywords: projects, orchestrator, proxy, cancellation.
 */
import type { NextRequest } from "next/server";
import { proxyWorkbenchOrchestratorRequest } from "../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/projects", {
    responseMode: "stream",
  });
}
