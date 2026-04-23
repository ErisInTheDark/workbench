import { NextResponse } from "next/server";

import type { UserInput } from "../../../../lib/codex/generated/app-server/v2/UserInput";
import { createTextInput } from "../../../../lib/codex/protocol";
import {
  readCodexThread,
  sendCodexThreadMessage,
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
      turns: thread.turns,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 503;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to read the Codex thread.",
      detail: error instanceof Error && "detail" in error ? (error as { detail?: string }).detail ?? "" : "",
    }, {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}

export async function POST(request: Request) {
  let payload: { input?: UserInput[] | string; text?: string; threadId?: string } | null = null;

  try {
    payload = await request.json() as { input?: UserInput[] | string; text?: string; threadId?: string };
  } catch {
    return NextResponse.json({
      error: "Invalid request body.",
    }, {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  const threadId = payload?.threadId?.trim() ?? "";
  const input = Array.isArray(payload?.input)
    ? payload.input
    : typeof payload?.input === "string" && payload.input.trim()
      ? [createTextInput(payload.input)]
      : [];
  const text = payload?.text?.trim() ?? "";
  const normalizedInput = [...input];

  if (text && !normalizedInput.some((entry) => entry.type === "text" && entry.text.trim())) {
    normalizedInput.unshift(createTextInput(text));
  }

  if (!threadId) {
    return NextResponse.json({
      error: "Missing threadId.",
    }, {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  if (!normalizedInput.length) {
    return NextResponse.json({
      error: "Message input cannot be empty.",
    }, {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const thread = await sendCodexThreadMessage(threadId, normalizedInput);
    return NextResponse.json({
      ...toThreadSummary(thread),
      turns: thread.turns,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 503;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to send the Codex thread message.",
      detail: error instanceof Error && "detail" in error ? (error as { detail?: string }).detail ?? "" : "",
    }, {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
