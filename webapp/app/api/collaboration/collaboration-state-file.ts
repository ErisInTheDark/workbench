/*
 * Exports:
 * - AUTO_WAKE_LEASE_TTL_MS: Collaboration auto-wake lease duration derived from the quiet-window delay. Keywords: collaboration, state, lease.
 * - CollaborationStateDiskFile: persisted Collaboration state plus transient auto-wake lease. Keywords: collaboration, disk, state.
 * - createCollaborationStateResponse: build the no-store state/registry compatibility response. Keywords: collaboration, API, response.
 * - readCollaborationStateDiskFile: read and normalize a project Collaboration state file. Keywords: collaboration, disk, read.
 * - writeCollaborationStateDiskFile: persist a project Collaboration state file. Keywords: collaboration, disk, write.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { projectRoot } from "../../../lib/project";
import type { WorkbenchCollaborationState } from "../../../lib/types";
import { WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS } from "../../../lib/workbench/collaboration/collaboration-registry";
import {
  EMPTY_WORKBENCH_COLLABORATION_STATE,
  createWorkbenchCollaborationStateRelativePath,
  normalizeWorkbenchCollaborationState,
  normalizeWorkbenchCollaborationThreadRegistryFromState,
} from "../../../lib/workbench/collaboration/collaboration-state";

export const AUTO_WAKE_LEASE_TTL_MS = WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS * 2;

interface AutoWakeLease {
  readonly expiresAt: number;
  readonly ownerId: string;
}

export interface CollaborationStateDiskFile {
  readonly autoWakeLease: AutoWakeLease | null;
  readonly state: WorkbenchCollaborationState;
}

function emptyDiskFile(): CollaborationStateDiskFile {
  return {
    autoWakeLease: null,
    state: EMPTY_WORKBENCH_COLLABORATION_STATE,
  };
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
    return emptyDiskFile();
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

function isCorruptJsonReadError(error: unknown) {
  return error instanceof SyntaxError;
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

export async function readCollaborationStateDiskFile(
  projectId: string,
  options: { allowCorruptRecovery?: boolean } = {},
): Promise<CollaborationStateDiskFile> {
  const absolutePath = resolveStateFile(projectId);
  try {
    const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as unknown;
    return normalizeDiskFile(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyDiskFile();
    }

    if (options.allowCorruptRecovery && isCorruptJsonReadError(error)) {
      return emptyDiskFile();
    }

    throw error;
  }
}

export async function writeCollaborationStateDiskFile(projectId: string, file: CollaborationStateDiskFile) {
  const absolutePath = resolveStateFile(projectId);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const state = normalizeWorkbenchCollaborationState(file.state);
  await fs.writeFile(absolutePath, `${JSON.stringify({
    autoWakeLease: file.autoWakeLease,
    state,
  }, null, 2)}\n`, "utf8");
}

export function createCollaborationStateResponse(state: WorkbenchCollaborationState, init?: ResponseInit) {
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
