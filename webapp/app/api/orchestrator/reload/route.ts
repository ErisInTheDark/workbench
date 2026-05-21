import { NextRequest, NextResponse } from "next/server";

import { getServerCodexBridgeHttpOrigins } from "../../../../lib/codex/server-bridge";
import type {
  OrchestratorReloadRequest,
  OrchestratorReloadResponse,
  OrchestratorReloadScope,
} from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_RELOAD_SCOPES = new Set<OrchestratorReloadScope>([
  "codex-bridge",
  "next-dev",
  "orchestrator-logic",
]);

function normalizeReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value.filter((scope): scope is OrchestratorReloadScope => (
      typeof scope === "string" && VALID_RELOAD_SCOPES.has(scope as OrchestratorReloadScope)
    )),
  ));
}

async function proxyReloadRequest(
  request: NextRequest,
  init: RequestInit,
) {
  const candidateOrigins = getServerCodexBridgeHttpOrigins(request);
  let lastError: unknown = null;

  for (let index = 0; index < candidateOrigins.length; index += 1) {
    const candidateOrigin = candidateOrigins[index];

    try {
      const upstreamResponse = await fetch(`${candidateOrigin}/orchestrator/reload`, init);
      const upstreamPayload = await upstreamResponse.json() as OrchestratorReloadResponse | { error?: string };
      if (!upstreamResponse.ok || !("ok" in upstreamPayload && upstreamPayload.ok)) {
        throw new Error(
          "error" in upstreamPayload && typeof upstreamPayload.error === "string"
            ? upstreamPayload.error
            : "Unable to reach the orchestrator reload endpoint.",
        );
      }

      return NextResponse.json(upstreamPayload, {
        headers: {
          "Cache-Control": "no-store",
        },
        status: upstreamResponse.status,
      });
    } catch (error) {
      lastError = error;
      if (index === candidateOrigins.length - 1) {
        break;
      }
    }
  }

  return NextResponse.json({
    error: lastError instanceof Error ? lastError.message : "Unable to reach the orchestrator reload endpoint.",
  }, {
    status: 502,
  });
}

export async function POST(request: NextRequest) {
  try {
    const requestBody = await request.json() as Partial<OrchestratorReloadRequest>;
    const scopes = normalizeReloadScopes(requestBody?.scopes);
    if (!scopes.length) {
      return NextResponse.json({ error: "At least one supported reload scope is required." }, { status: 400 });
    }

    return await proxyReloadRequest(request, {
      body: JSON.stringify({ scopes } satisfies OrchestratorReloadRequest),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Invalid orchestrator reload request.",
    }, {
      status: 400,
    });
  }
}

export async function GET(request: NextRequest) {
  return await proxyReloadRequest(request, {
    cache: "no-store",
    method: "GET",
  });
}
