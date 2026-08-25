import { NextRequest, NextResponse } from "next/server";

import { getServerWorkbenchOrchestratorOrigins } from "../../../../lib/codex/server-orchestrator";
import type {
  OrchestratorReloadRequest,
  OrchestratorReloadResponse,
} from "../../../../lib/types";
import {
  normalizeOrchestratorReloadScopes,
  validateOrchestratorReloadScopeCombination,
} from "../../../../lib/workbench/orchestrator-reload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxyReloadRequest(
  request: NextRequest,
  init: RequestInit,
) {
  const candidateOrigins = getServerWorkbenchOrchestratorOrigins(request);
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
    const scopes = normalizeOrchestratorReloadScopes(requestBody?.scopes);
    const all = requestBody?.all === true;
    if (!all && !scopes.length) {
      return NextResponse.json({ error: "At least one supported reload scope is required." }, { status: 400 });
    }
    const combinationError = validateOrchestratorReloadScopeCombination(scopes);
    if (combinationError) {
      return NextResponse.json({ error: combinationError }, { status: 400 });
    }

    return await proxyReloadRequest(request, {
      body: JSON.stringify({ ...(all ? { all: true } : {}), ...(scopes.length ? { scopes } : {}) } satisfies OrchestratorReloadRequest),
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
