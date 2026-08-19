/*
 * Exports:
 * - runtime/dynamic: keep the stateless Git arc proxy on the uncached Node.js route boundary. Keywords: api, git, arc, proxy.
 * - POST: forward one buffered Git arc request to the reloadable orchestrator feature. Keywords: api, git, arc, orchestrator.
 */
import type { NextRequest } from "next/server";

import { proxyWorkbenchOrchestratorRequest } from "../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/git-arc", { responseMode: "buffer" });
}
