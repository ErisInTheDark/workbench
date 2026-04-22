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
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to list Codex threads.",
      detail: error instanceof Error && "detail" in error ? (error as { detail?: string }).detail ?? "" : "",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
