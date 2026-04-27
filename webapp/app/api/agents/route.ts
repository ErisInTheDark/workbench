import { NextResponse } from "next/server";

import { listUserInvocableAgents } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await listUserInvocableAgents();
  return NextResponse.json({ data }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}