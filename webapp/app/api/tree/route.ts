import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import { getProjectSnapshot, createProjectEntry } from "../../../lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getProjectSnapshot();
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const {
      parentPath = "",
      name,
      type,
    } = await request.json();

    if (type !== "file" && type !== "directory") {
      return NextResponse.json({ error: "A valid entry type is required." }, { status: 400 });
    }

    const createdPath = await createProjectEntry(parentPath, name, type);
    const snapshot = await getProjectSnapshot();
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
