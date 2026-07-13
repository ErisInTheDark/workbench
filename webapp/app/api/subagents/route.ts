/*
 * Exports:
 * - runtime/dynamic: keep subagent lifecycle requests on stateless Node route handling. Keywords: subagent, bridge, node.
 * - GET: list durable project or parent-scoped subagent metadata for UI rendering. Keywords: subagent, list, parent, ui.
 * - POST: proxy allowlisted CLI subagent lifecycle actions, including cancellable waits. Keywords: subagent, create, wait, message, stop.
 */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { sendServerWorkbenchOrchestratorRequest } from "../../../lib/codex/server-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_METHODS = {
  create: "workbench/subagent/create",
  message: "workbench/subagent/message",
  profiles: "workbench/subagent/profiles",
  stop: "workbench/subagent/stop",
} as const;

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "Workbench subagent request failed." }, { status: 400 });
}

export async function GET(request: NextRequest) {
  try {
    const result = await sendServerWorkbenchOrchestratorRequest(request, "codex", {
      method: "workbench/subagent/list",
      params: {
        cwd: request.nextUrl.searchParams.get("cwd"),
        parentThreadId: request.nextUrl.searchParams.get("parentThreadId"),
      },
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return errorResponse(new Error("A JSON subagent request is required.")); }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "wait") {
    const method = ACTION_METHODS[action as keyof typeof ACTION_METHODS];
    if (!method) return errorResponse(new Error("Unsupported Workbench subagent action."));
    try {
      const result = await sendServerWorkbenchOrchestratorRequest(request, "codex", { method, params: body });
      return action === "message" || action === "stop"
        ? new NextResponse(null, { status: 204 })
        : NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return errorResponse(error); }
  }

  const waitId = randomUUID();
  const cancel = () => {
    void sendServerWorkbenchOrchestratorRequest(request, "codex", {
      method: "workbench/subagent/waitCancel",
      params: { waitId },
    }, { signal: null }).catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await sendServerWorkbenchOrchestratorRequest<{ output: string }>(request, "codex", {
      method: "workbench/subagent/wait",
      params: { ...body, waitId },
    });
    return new NextResponse(result.output, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    return errorResponse(error);
  } finally {
    request.signal.removeEventListener("abort", cancel);
  }
}
