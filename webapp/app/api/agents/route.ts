import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { listUserInvocableAgents } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const data = await listUserInvocableAgents(request.nextUrl.searchParams.get("projectId"));
    return NextResponse.json({ data }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
