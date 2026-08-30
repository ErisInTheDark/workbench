/*
 * Exports:
 * - GET: keep direct Next launches memory-only by redirecting to the Workbench root. Keywords: workbench, launch, memory, redirect.
 */

import { NextResponse } from "next/server";

export function GET() {
  return new NextResponse(null, {
    headers: {
      "Cache-Control": "private, no-store",
      Location: "/",
    },
    status: 307,
  });
}
