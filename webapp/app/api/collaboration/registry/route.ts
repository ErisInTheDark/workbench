/*
 * Exports:
 * - runtime/dynamic: force Collaboration state reads and writes onto Node.js without static caching. Keywords: collaboration, state, node.
 * - GET/PUT/POST: read, merge-save, and claim activity-gated auto-wake for a project Collaboration state. Keywords: collaboration, state, auto-wake.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { projectRoot, resolveProjectRoot } from "../../../../lib/project";
import type { WorkbenchCollaborationState } from "../../../../lib/types";
import { WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS } from "../../../../lib/workbench/collaboration/collaboration-registry";
import {
  EMPTY_WORKBENCH_COLLABORATION_STATE,
  createWorkbenchCollaborationStateRelativePath,
  mergeWorkbenchCollaborationState,
  normalizeWorkbenchCollaborationState,
  normalizeWorkbenchCollaborationThreadRegistryFromState,
} from "../../../../lib/workbench/collaboration/collaboration-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTO_WAKE_LEASE_TTL_MS = WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS * 2;

interface AutoWakeLease {
  readonly expiresAt: number;
  readonly ownerId: string;
}

interface CollaborationStateDiskFile {
  readonly autoWakeLease: AutoWakeLease | null;
  readonly state: WorkbenchCollaborationState;
}

function normalizeAutoWakeLease(value: unknown): AutoWakeLease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const ownerId = typeof candidate.ownerId === "string" ? candidate.ownerId.trim() : "";
  const expiresAt = typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt)
    ? Math.max(0, Math.trunc(candidate.expiresAt))
    : 0;

  return ownerId && expiresAt
    ? { expiresAt, ownerId }
    : null;
}

function normalizeDiskFile(value: unknown): CollaborationStateDiskFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      autoWakeLease: null,
      state: EMPTY_WORKBENCH_COLLABORATION_STATE,
    };
  }

  const candidate = value as Record<string, unknown>;
  return {
    autoWakeLease: normalizeAutoWakeLease(candidate.autoWakeLease),
    state: normalizeWorkbenchCollaborationState(
      "state" in candidate
        ? candidate.state
        : "registry" in candidate
          ? candidate.registry
          : candidate,
    ),
  };
}

function resolveStateFile(projectId: string) {
  const relativePath = createWorkbenchCollaborationStateRelativePath(projectId);
  const absolutePath = path.resolve(projectRoot, relativePath);
  const normalizedProjectRoot = path.resolve(projectRoot);
  if (absolutePath !== normalizedProjectRoot && !absolutePath.startsWith(`${normalizedProjectRoot}${path.sep}`)) {
    throw new Error("Collaboration state path is outside Workbench storage.");
  }

  return absolutePath;
}

async function readDiskFile(projectId: string): Promise<CollaborationStateDiskFile> {
  const absolutePath = resolveStateFile(projectId);
  try {
    const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as unknown;
    return normalizeDiskFile(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        autoWakeLease: null,
        state: EMPTY_WORKBENCH_COLLABORATION_STATE,
      };
    }

    throw error;
  }
}

async function writeDiskFile(projectId: string, file: CollaborationStateDiskFile) {
  const absolutePath = resolveStateFile(projectId);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const state = normalizeWorkbenchCollaborationState(file.state);
  await fs.writeFile(absolutePath, `${JSON.stringify({
    autoWakeLease: file.autoWakeLease,
    state,
  }, null, 2)}\n`, "utf8");
}

function stateResponse(state: WorkbenchCollaborationState, init?: ResponseInit) {
  return NextResponse.json({
    registry: normalizeWorkbenchCollaborationThreadRegistryFromState(state),
    state,
  }, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const resolvedProject = await resolveProjectRoot(request.nextUrl.searchParams.get("projectId"));
    const file = await readDiskFile(resolvedProject.id);
    return stateResponse(file.state);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read the Collaboration state." }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { projectId, registry, state } = await request.json();
    const resolvedProject = await resolveProjectRoot(projectId);
    const incomingState = normalizeWorkbenchCollaborationState(state ?? registry);
    const currentFile = await readDiskFile(resolvedProject.id);
    const mergedState = mergeWorkbenchCollaborationState(currentFile.state, incomingState);
    await writeDiskFile(resolvedProject.id, {
      autoWakeLease: currentFile.autoWakeLease,
      state: mergedState,
    });
    return stateResponse(mergedState);
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
    const currentFile = await readDiskFile(resolvedProject.id);
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

    const nextState = {
      ...currentFile.state,
      lastAutoWakeAt: now,
    };
    await writeDiskFile(resolvedProject.id, {
      autoWakeLease: {
        expiresAt: now + AUTO_WAKE_LEASE_TTL_MS,
        ownerId: normalizedOwnerId,
      },
      state: nextState,
    });
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
