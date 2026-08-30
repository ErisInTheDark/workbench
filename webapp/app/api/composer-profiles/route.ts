/*
 * Exports:
 * - runtime/dynamic: keep durable composer profiles on stateless Node route handling. Keywords: composer, profiles, bridge, node.
 * - GET/POST: proxy profile reads and mutations to the orchestrator-owned store. Keywords: composer, profiles, stateless, orchestrator.
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
    const result = await sendServerWorkbenchOrchestratorRequest(request, "codex", { method: "profiles/read", params: {} });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { action?: unknown; mutation?: unknown };
    if (body.action !== "mutate") throw new Error("Composer profile action must be mutate.");
    const mutation = body.mutation && typeof body.mutation === "object" && !Array.isArray(body.mutation)
      ? body.mutation as { kind?: unknown; profile?: unknown; profileId?: unknown }
      : null;
    if (mutation?.kind !== "upsert" && mutation?.kind !== "delete") {
      throw new Error("Composer profile mutation must be upsert or delete.");
    }
    const result = await sendServerWorkbenchOrchestratorRequest(request, "codex", {
      method: mutation.kind === "upsert" ? "profiles/upsert" : "profiles/delete",
      params: mutation.kind === "upsert"
        ? { profile: mutation.profile }
        : { profileId: mutation.profileId },
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
