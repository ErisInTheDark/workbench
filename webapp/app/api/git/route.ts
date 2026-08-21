/*
 * Exports:
 * - runtime/dynamic: keep the stateless thread Git proxy on the uncached Node.js route boundary. Keywords: api, git, thread, proxy.
 * - POST: forward one buffered thread Git request to the reloadable orchestrator feature. Keywords: api, git, orchestrator, proxy.
 */
import type { NextRequest } from "next/server";

import { proxyWorkbenchOrchestratorRequest } from "../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/thread-git", { responseMode: "buffer" });
}
