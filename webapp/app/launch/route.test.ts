/*
 * No production exports. Node tests protect standalone launch cookie scope, canonical project redirects, and cache isolation. Keywords: workbench, launch, project, cookie, redirect, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

import {
  createLastProjectLaunchCookie,
  LAST_PROJECT_LAUNCH_COOKIE_NAME,
} from "../../lib/workbench/state/last-project-cookie";
import { GET } from "./route";

test("standalone launches preserve the installed origin with a relative project redirect", () => {
  for (const origin of [
    "http://localhost:3002",
    "http://127.0.0.1:3002",
    "https://workbench.tailnet-example.ts.net:8443",
  ]) {
    const request = new NextRequest(`${origin}/launch`, {
      headers: { cookie: `${LAST_PROJECT_LAUNCH_COOKIE_NAME}=nested%2Fproject%20one` },
    });
    const response = GET(request);

    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "/nested/project%20one");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("standalone launches fall back to Workbench root without a valid project cookie", () => {
  const response = GET(new NextRequest("http://workbench.local/launch", {
    headers: { cookie: `${LAST_PROJECT_LAUNCH_COOKIE_NAME}=%E0%A4%A` },
  }));

  assert.equal(response.headers.get("location"), "/");
});

test("last-project persistence stays scoped to the launch request", () => {
  const cookie = createLastProjectLaunchCookie("nested/project one");
  assert.match(cookie, /^workbench-last-project=nested%2Fproject%20one;/u);
  assert.match(cookie, /Path=\/launch/u);
  assert.match(cookie, /SameSite=Strict/u);
});
