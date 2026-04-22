import { NextResponse } from "next/server";

import {
  readCodexThread,
  renderThreadMarkdown,
  toThreadSummary,
} from "../../../../lib/codex/server-app-server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const threadId = searchParams.get("threadId") ?? "";

  if (!threadId) {
    return NextResponse.json({
      error: "Missing threadId.",
    }, {
      status: 400,
    });
  }

  try {
    const thread = await readCodexThread(threadId);
    return NextResponse.json({
      ...toThreadSummary(thread),
      markdown: renderThreadMarkdown(thread),
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to read the Codex thread.",
      detail: error instanceof Error && "detail" in error ? (error as { detail?: string }).detail ?? "" : "",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
