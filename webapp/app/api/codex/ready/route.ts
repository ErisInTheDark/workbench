import { NextResponse } from "next/server";

import { probeCodexAppServerReady } from "../../../../lib/codex/health";

export async function GET() {
  const status = await probeCodexAppServerReady();

  return NextResponse.json(status, {
    status: status.ok ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
