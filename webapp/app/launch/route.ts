/*
 * Exports:
 * - GET: redirect standalone Workbench launches to the last confirmed project sidebar without caching user-specific state. Keywords: workbench, launch, project, cookie, redirect, iOS.
 */

import { type NextRequest, NextResponse } from "next/server";

import {
  LAST_PROJECT_LAUNCH_COOKIE_NAME,
  resolveLastProjectLaunchHref,
} from "../../lib/workbench/state/last-project-cookie";

export function GET(request: NextRequest) {
  const launchHref = resolveLastProjectLaunchHref(request.cookies.get(LAST_PROJECT_LAUNCH_COOKIE_NAME)?.value);
  return new NextResponse(null, {
    headers: {
      "Cache-Control": "private, no-store",
      Location: launchHref,
    },
    status: 307,
  });
}
