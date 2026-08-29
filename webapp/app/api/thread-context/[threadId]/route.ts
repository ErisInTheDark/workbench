/*
 * Exports:
 * - runtime/dynamic: force Thread Recall reads onto the Node.js runtime without static caching. Keywords: thread recall, markdown, node.
 * - GET/POST: adapt the browser route to the shared Thread Recall controller and orchestrator-backed bundle loader. Keywords: thread recall, history, search, expand, orchestrator.
 */
import { type NextRequest } from "next/server";

import type { WorkbenchThreadContextReadResponse } from "../../../../lib/types";
import { sendServerWorkbenchOrchestratorRequest } from "../../../../lib/codex/server-orchestrator";
import WorkbenchThreadRecallController, {
  toWorkbenchThreadRecallBundle,
} from "../../../../lib/workbench/thread/WorkbenchThreadRecallController";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function controller(request: NextRequest) {
  return new WorkbenchThreadRecallController({
    readBundle: async (threadId) => toWorkbenchThreadRecallBundle(
      await sendServerWorkbenchOrchestratorRequest<WorkbenchThreadContextReadResponse>(request, "codex", {
        method: "thread/context/read",
        params: {
          includeTurns: true,
          threadId,
          workbenchReadScope: "threadRecall",
        },
        workbenchThreadHydration: { mode: "legacyFull" },
      }),
    ),
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return await controller(request).execute({
    method: "GET",
    searchParams: request.nextUrl.searchParams,
    threadId,
  }, request.signal);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return await controller(request).execute({
    body: request.json(),
    method: "POST",
    searchParams: request.nextUrl.searchParams,
    threadId,
  }, request.signal);
}
