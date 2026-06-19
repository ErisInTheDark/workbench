import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { containsExactGuidanceText, readCodexGlobalGuidance } from "../../../lib/codex/CodexGlobalGuidance";
import { listUserInvocableAgents, readUserInvocableAgentDefinition } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const agentPath = request.nextUrl.searchParams.get("agentPath");
    if (agentPath?.trim()) {
      const [data, codexGlobalGuidance] = await Promise.all([
        readUserInvocableAgentDefinition(agentPath, projectId),
        readCodexGlobalGuidance(),
      ]);

      return NextResponse.json({
        codexGlobalDuplicate: containsExactGuidanceText(codexGlobalGuidance, data.prompt),
        data,
      }, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const data = await listUserInvocableAgents(projectId);

    return NextResponse.json({ data }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
