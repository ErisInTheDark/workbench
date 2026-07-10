/*
 * Exports:
 * - runtime/dynamic: keep Browse session management on the Node.js runtime without static caching. Keywords: browse, sessions, api, node runtime.
 * - GET: list Workbench-known Browse sessions for a project or cwd. Keywords: browse, sessions, list, project.
 * - POST: stop, force-stop, or forget one Workbench Browse session. Keywords: browse, sessions, stop, forget.
 */
import { NextRequest, NextResponse } from "next/server";

import type {
  WorkbenchBrowseSessionControlRequest,
  WorkbenchBrowseSessionControlResponse,
  WorkbenchBrowseSessionListResponse,
} from "../../../../lib/types";
import { workbenchBrowseCommandQueue } from "../../../../lib/workbench/browse/WorkbenchBrowseCommandQueue";
import WorkbenchBrowseSessionController from "../../../../lib/workbench/browse/WorkbenchBrowseSessionController";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const MAX_BROWSE_SESSION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BROWSE_SESSION_TIMEOUT_MS = 120_000;
const browseSessionController = new WorkbenchBrowseSessionController();

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimeout(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return DEFAULT_BROWSE_SESSION_TIMEOUT_MS;
  }

  return Math.min(Math.trunc(numericValue), MAX_BROWSE_SESSION_TIMEOUT_MS);
}

function noStoreJson<TPayload>(payload: TPayload, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeControlRequest(value: unknown): WorkbenchBrowseSessionControlRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  const action = value.action === "forget" || value.action === "stop" ? value.action : null;
  const session = normalizeString(value.session);
  if (!action || !SESSION_NAME_PATTERN.test(session)) {
    return null;
  }

  return {
    action,
    cwd: normalizeString(value.cwd) || null,
    force: value.force === true,
    projectId: normalizeString(value.projectId) || null,
    session,
    threadId: normalizeString(value.threadId) || null,
    timeoutMs: normalizeTimeout(value.timeoutMs),
  };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const response = await workbenchBrowseCommandQueue.run(async () => await browseSessionController.listSessions({
      cwd: normalizeString(searchParams.get("cwd")) || null,
      includeRuntime: !["false", "0"].includes(normalizeString(searchParams.get("includeRuntime")).toLowerCase()),
      projectId: normalizeString(searchParams.get("projectId")) || null,
      threadId: normalizeString(searchParams.get("threadId")) || null,
      timeoutMs: normalizeTimeout(searchParams.get("timeoutMs")),
    }));
    return noStoreJson<WorkbenchBrowseSessionListResponse>(response);
  } catch (error) {
    return noStoreJson({
      error: error instanceof Error ? error.message : "Unable to list Browse sessions.",
    }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const requestBody = await request.json().catch(() => null);
    const payload = normalizeControlRequest(requestBody);
    if (!payload) {
      return noStoreJson({
        error: "A valid Browse session control request is required.",
      }, { status: 400 });
    }

    const response = await workbenchBrowseCommandQueue.run(async () => (
      payload.action === "forget"
        ? await browseSessionController.stopSession({ ...payload, action: "forget" })
        : await browseSessionController.stopSession(payload)
    ));
    return noStoreJson<WorkbenchBrowseSessionControlResponse>(response);
  } catch (error) {
    return noStoreJson({
      error: error instanceof Error ? error.message : "Unable to update Browse session.",
    }, { status: 400 });
  }
}
