import { NextResponse } from "next/server";

import { listCodexThreads } from "../../../../lib/codex/server-app-server";

export async function GET() {
  try {
    const threads = await listCodexThreads();
    return NextResponse.json({ threads }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 503;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to list Codex threads.",
      detail: error instanceof Error && "detail" in error ? (error as { detail?: string }).detail ?? "" : "",
    }, {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
