import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { listProjectSkills } from "../../../../lib/project";
import {
  buildWorkbenchLibraryBootstrapInstructions,
  listWorkbenchLibraryInstructions,
  listWorkbenchLibrarySkills,
} from "../../../../lib/workbench-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const [librarySkills, projectSkills, instructionPacks, instructions] = await Promise.all([
      listWorkbenchLibrarySkills(),
      projectId ? listProjectSkills(projectId) : Promise.resolve([]),
      listWorkbenchLibraryInstructions(),
      buildWorkbenchLibraryBootstrapInstructions(),
    ]);
    const data = [...projectSkills, ...librarySkills];
    return NextResponse.json({ data, instructionPacks, instructions }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
