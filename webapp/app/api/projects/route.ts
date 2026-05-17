import { NextResponse } from "next/server";

import { discoverProjects, projectsRoot, normalizeRelativePath } from "../../../lib/project";
import type { WorkbenchProjectsPayload } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await discoverProjects({ refresh: true });
  return NextResponse.json({
    data,
    rootPath: normalizeRelativePath(projectsRoot),
  } satisfies WorkbenchProjectsPayload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
