import { NextResponse } from "next/server";

import {
  buildWorkbenchLibraryBootstrapInstructions,
  listWorkbenchLibraryInstructions,
  listWorkbenchLibrarySkills,
} from "../../../../lib/workbench-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [data, instructionPacks, instructions] = await Promise.all([
      listWorkbenchLibrarySkills(),
      listWorkbenchLibraryInstructions(),
      buildWorkbenchLibraryBootstrapInstructions(),
    ]);
    return NextResponse.json({ data, instructionPacks, instructions }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
