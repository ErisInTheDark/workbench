/*
 * Exports:
 * - runtime/dynamic: force Collaboration state reads and writes onto Node.js without static caching. Keywords: collaboration, state, node.
 * - GET/PUT/POST: read, merge-save, and claim activity-gated auto-wake for a project Collaboration state. Keywords: collaboration, state, auto-wake.
 */

import { NextRequest, NextResponse } from "next/server";

import { resolveProjectRoot } from "../../../../lib/project";
import { WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS } from "../../../../lib/workbench/collaboration/collaboration-registry";
import {
  normalizeWorkbenchCollaborationState,
  normalizeWorkbenchCollaborationThreadRegistryFromState,
  selectLatestWorkbenchCollaborationState,
  touchWorkbenchCollaborationState,
} from "../../../../lib/workbench/collaboration/collaboration-state";
import {
  AUTO_WAKE_LEASE_TTL_MS,
  createCollaborationStateResponse,
  readCollaborationStateDiskFile,
  writeCollaborationStateDiskFile,
} from "../collaboration-state-file";
import { notifyCollaborationStateUpdated } from "../collaboration-state-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeRevisionTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

export async function GET(request: NextRequest) {
  try {
    const resolvedProject = await resolveProjectRoot(request.nextUrl.searchParams.get("projectId"));
    const file = await readCollaborationStateDiskFile(resolvedProject.id);
    return createCollaborationStateResponse(file.state);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read the Collaboration state." }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { baseUpdatedAt, projectId, registry, state } = await request.json();
    const resolvedProject = await resolveProjectRoot(projectId);
    const incomingState = normalizeWorkbenchCollaborationState(state ?? registry);
    const currentFile = await readCollaborationStateDiskFile(resolvedProject.id, { allowCorruptRecovery: true });
    const incomingBaseUpdatedAt = normalizeRevisionTimestamp(baseUpdatedAt);
    const nextState = incomingBaseUpdatedAt < currentFile.state.updatedAt
      ? currentFile.state
      : selectLatestWorkbenchCollaborationState(currentFile.state, incomingState);
    await writeCollaborationStateDiskFile(resolvedProject.id, {
      autoWakeLease: currentFile.autoWakeLease,
      state: nextState,
    });
    await notifyCollaborationStateUpdated(request, resolvedProject.id, nextState);
    return createCollaborationStateResponse(nextState);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save the Collaboration state." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { action, ownerId, projectId } = await request.json();
    if (action !== "claimAutoWake") {
      return NextResponse.json({ error: "Unsupported Collaboration state action." }, { status: 400 });
    }

    const normalizedOwnerId = typeof ownerId === "string" ? ownerId.trim() : "";
    if (!normalizedOwnerId) {
      return NextResponse.json({ error: "A valid auto-run owner id is required." }, { status: 400 });
    }

    const resolvedProject = await resolveProjectRoot(projectId);
    const currentFile = await readCollaborationStateDiskFile(resolvedProject.id);
    const now = Date.now();
    const activeLease = currentFile.autoWakeLease && currentFile.autoWakeLease.expiresAt > now
      ? currentFile.autoWakeLease
      : null;
    const tooSoon = now - currentFile.state.lastAutoWakeAt < WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS;
    if (!currentFile.state.autoWakeEnabled || tooSoon || (activeLease && activeLease.ownerId !== normalizedOwnerId)) {
      return NextResponse.json({
        acquired: false,
        registry: normalizeWorkbenchCollaborationThreadRegistryFromState(currentFile.state),
        state: currentFile.state,
      }, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const nextState = touchWorkbenchCollaborationState({
      ...currentFile.state,
      lastAutoWakeAt: now,
    }, now);
    await writeCollaborationStateDiskFile(resolvedProject.id, {
      autoWakeLease: {
        expiresAt: now + AUTO_WAKE_LEASE_TTL_MS,
        ownerId: normalizedOwnerId,
      },
      state: nextState,
    });
    await notifyCollaborationStateUpdated(request, resolvedProject.id, nextState);
    return NextResponse.json({
      acquired: true,
      registry: normalizeWorkbenchCollaborationThreadRegistryFromState(nextState),
      state: nextState,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to claim Collaboration auto-run." }, { status: 400 });
  }
}
