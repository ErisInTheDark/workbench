import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { containsExactGuidanceText, readCodexGlobalGuidance } from "../../../../lib/codex/CodexGlobalGuidance";
import { listProjectSkillDefinitions } from "../../../../lib/project";
import {
  buildWorkbenchLibraryBootstrapInstructions,
  listActiveWorkbenchSkillDefinitions,
  listWorkbenchLibraryInstructions,
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
    const [projectSkills, instructionPacks] = await Promise.all([
      projectId ? listProjectSkillDefinitions(projectId) : Promise.resolve([]),
      listWorkbenchLibraryInstructions(),
    ]);
    const activeSkills = await listActiveWorkbenchSkillDefinitions(projectSkills);
    const data = activeSkills.map(summarizeSkill);
    const codexGlobalGuidance = await readCodexGlobalGuidance();
    const globallyPresentInstructionPacks = instructionPacks
      .filter((instructionPack) => containsExactGuidanceText(codexGlobalGuidance, instructionPack.content))
      .map((instructionPack) => instructionPack.content);
    const instructions = await buildWorkbenchLibraryBootstrapInstructions(projectSkills, {
      skipInstructionPackContents: globallyPresentInstructionPacks,
    });

    return NextResponse.json({ data, instructionPacks, instructions }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
