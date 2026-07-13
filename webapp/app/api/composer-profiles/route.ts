/*
 * Exports:
 * - runtime/dynamic: keep durable composer profiles on stateless Node route handling. Keywords: composer, profiles, bridge, node.
 * - GET/POST: proxy profile reads, legacy import, and mutations to the orchestrator-owned store. Keywords: composer, profiles, stateless, orchestrator.
 */
import { NextRequest, NextResponse } from "next/server";

import { sendServerWorkbenchOrchestratorRequest } from "../../../lib/codex/server-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to persist composer profiles." }, { status: 400 });
}

export async function GET(request: NextRequest) {
  try {
    const result = await sendServerWorkbenchOrchestratorRequest(request, "codex", { method: "workbench/composerProfiles/read", params: {} });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { action?: unknown; mutation?: unknown; profiles?: unknown };
    const method = body.action === "importLegacy"
      ? "workbench/composerProfiles/importLegacy"
      : body.action === "mutate"
        ? "workbench/composerProfiles/mutate"
        : null;
    if (!method) throw new Error("Composer profile action must be importLegacy or mutate.");
    const result = await sendServerWorkbenchOrchestratorRequest(request, "codex", { method, params: { mutation: body.mutation, profiles: body.profiles } });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
