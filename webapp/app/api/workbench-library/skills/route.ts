import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { listProjectSkillDefinitions } from "../../../../lib/project";
import {
  buildWorkbenchLibraryBootstrapInstructions,
  listWorkbenchLibraryInstructions,
  listWorkbenchLibrarySkillDefinitions,
} from "../../../../lib/workbench-library";
import type { WorkbenchSkillDefinition } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function summarizeSkill(skill: WorkbenchSkillDefinition) {
  return {
    description: skill.description,
    name: skill.name,
    path: skill.path,
    relativePath: skill.relativePath,
  };
}

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId");
    const [librarySkills, projectSkills, instructionPacks] = await Promise.all([
      listWorkbenchLibrarySkillDefinitions(),
      projectId ? listProjectSkillDefinitions(projectId) : Promise.resolve([]),
      listWorkbenchLibraryInstructions(),
    ]);
    const data = [...projectSkills, ...librarySkills].map(summarizeSkill);
    const instructions = await buildWorkbenchLibraryBootstrapInstructions(projectSkills);

    return NextResponse.json({ data, instructionPacks, instructions }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
