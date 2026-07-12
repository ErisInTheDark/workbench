/*
 * Exports:
 * - runtime/dynamic: keep project discovery on a dynamic Node.js transport route. Keywords: projects, api, node runtime, stateless.
 * - GET: stream the orchestrator-owned serialized project list, with a stateless local fallback for pre-bootstrap orchestrators. Keywords: projects, orchestrator, proxy, compatibility.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import type { WorkbenchProjectsPayload } from "../../../lib/types";
import { proxyWorkbenchOrchestratorRequest } from "../../../lib/workbench/orchestrator-http-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function localProjectsFallback() {
  const { discoverProjects, normalizeRelativePath, projectsRoot } = await import("../../../lib/project");
  return NextResponse.json({
    data: await discoverProjects(),
    rootPath: normalizeRelativePath(projectsRoot),
  } satisfies WorkbenchProjectsPayload, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const response = await proxyWorkbenchOrchestratorRequest(request, "/orchestrator/projects", {
    responseMode: "stream",
    timeoutMs: 10_000,
  });
  if (response.status !== 404) return response;
  await response.arrayBuffer();
  return await localProjectsFallback();
}
