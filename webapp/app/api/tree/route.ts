import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { getProjectSnapshot, createProjectEntry, resolveProjectRoot } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const snapshot = await getProjectSnapshot(request.nextUrl.searchParams.get("projectId"));
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const {
      parentPath = "",
      projectId,
      name,
      type,
    } = await request.json();

    if (type !== "file" && type !== "directory") {
      return NextResponse.json({ error: "A valid entry type is required." }, { status: 400 });
    }

    const resolvedProject = await resolveProjectRoot(projectId);
    const createdPath = await createProjectEntry(parentPath, name, type, resolvedProject.root);
    const snapshot = await getProjectSnapshot(resolvedProject.id);
    return NextResponse.json({
      ...snapshot,
      path: createdPath,
      type,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
