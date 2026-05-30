import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { listUserInvocableAgents, readUserInvocableAgentDefinition } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const agentPath = request.nextUrl.searchParams.get("agentPath");
    const data = agentPath?.trim()
      ? await readUserInvocableAgentDefinition(agentPath, projectId)
      : await listUserInvocableAgents(projectId);

    return NextResponse.json({ data }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
