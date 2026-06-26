import { NextRequest, NextResponse } from "next/server";

import { sendServerWorkbenchBridgeRequest } from "../../../lib/codex/server-bridge";
import { normalizeThreadTitle } from "../../../lib/thread-bootstrap";
import type { WorkbenchHarness } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeHarness(value: unknown): WorkbenchHarness | null {
  return value === "copilot" || value === "codex" || value === "opencode" ? value : null;
}

export async function POST(request: NextRequest) {
  try {
    const {
      harness: rawHarness,
      threadId: rawThreadId,
      title: rawTitle,
    } = await request.json();

    const harness = normalizeHarness(rawHarness);
    const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
    const title = normalizeThreadTitle(typeof rawTitle === "string" ? rawTitle : null);

    if (!harness) {
      return NextResponse.json({ error: "A valid harness is required." }, { status: 400 });
    }

    if (!threadId) {
      return NextResponse.json({ error: "A thread id is required." }, { status: 400 });
    }

    if (!title) {
      return NextResponse.json({ error: "A non-empty title is required." }, { status: 400 });
    }

    await sendServerWorkbenchBridgeRequest<Record<string, never>>(request, harness, {
      method: "thread/name/set",
      params: {
        name: title,
        threadId,
      },
    });

    return NextResponse.json({
      ok: true,
      threadId,
      title,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to update the thread title.",
    }, {
      status: 400,
    });
  }
}
