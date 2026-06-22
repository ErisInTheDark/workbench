/*
 * Exports:
 * - runtime/dynamic: force Collaboration registry reads and writes onto Node.js without static caching. Keywords: collaboration, registry, node.
 * - GET/PUT/POST: read, merge-save, and claim activity-gated auto-wake for a project Collaboration registry. Keywords: collaboration, registry, auto-wake.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { projectRoot, resolveProjectRoot } from "../../../../lib/project";
import {
  EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY,
  WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS,
  createWorkbenchCollaborationRegistryRelativePath,
  mergeWorkbenchCollaborationThreadRegistry,
  normalizeWorkbenchCollaborationThreadRegistry,
} from "../../../../lib/workbench/collaboration/collaboration-registry";
import type { WorkbenchCollaborationThreadRegistry } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTO_WAKE_LEASE_TTL_MS = WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS * 2;

interface AutoWakeLease {
  readonly expiresAt: number;
  readonly ownerId: string;
}

interface CollaborationRegistryDiskFile {
  readonly autoWakeLease: AutoWakeLease | null;
  readonly registry: WorkbenchCollaborationThreadRegistry;
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

function normalizeDiskFile(value: unknown): CollaborationRegistryDiskFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      autoWakeLease: null,
      registry: EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY,
    };
  }

  const candidate = value as Record<string, unknown>;
  return {
    autoWakeLease: normalizeAutoWakeLease(candidate.autoWakeLease),
    registry: normalizeWorkbenchCollaborationThreadRegistry("registry" in candidate ? candidate.registry : candidate),
  };
}

function resolveRegistryFile(projectId: string) {
  const relativePath = createWorkbenchCollaborationRegistryRelativePath(projectId);
  const absolutePath = path.resolve(projectRoot, relativePath);
  const normalizedProjectRoot = path.resolve(projectRoot);
  if (absolutePath !== normalizedProjectRoot && !absolutePath.startsWith(`${normalizedProjectRoot}${path.sep}`)) {
    throw new Error("Collaboration registry path is outside Workbench storage.");
  }

  return absolutePath;
}

async function readDiskFile(projectId: string): Promise<CollaborationRegistryDiskFile> {
  const absolutePath = resolveRegistryFile(projectId);
  try {
    const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as unknown;
    return normalizeDiskFile(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        autoWakeLease: null,
        registry: EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY,
      };
    }

    throw error;
  }
}

async function writeDiskFile(projectId: string, file: CollaborationRegistryDiskFile) {
  const absolutePath = resolveRegistryFile(projectId);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify({
    autoWakeLease: file.autoWakeLease,
    registry: normalizeWorkbenchCollaborationThreadRegistry(file.registry),
  }, null, 2)}\n`, "utf8");
}

function registryResponse(registry: WorkbenchCollaborationThreadRegistry, init?: ResponseInit) {
  return NextResponse.json({
    registry,
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
    return registryResponse(file.registry);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read the Collaboration registry." }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { projectId, registry } = await request.json();
    const resolvedProject = await resolveProjectRoot(projectId);
    const incomingRegistry = normalizeWorkbenchCollaborationThreadRegistry(registry);
    const currentFile = await readDiskFile(resolvedProject.id);
    const mergedRegistry = mergeWorkbenchCollaborationThreadRegistry(currentFile.registry, incomingRegistry);
    await writeDiskFile(resolvedProject.id, {
      autoWakeLease: currentFile.autoWakeLease,
      registry: mergedRegistry,
    });
    return registryResponse(mergedRegistry);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save the Collaboration registry." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { action, ownerId, projectId } = await request.json();
    if (action !== "claimAutoWake") {
      return NextResponse.json({ error: "Unsupported Collaboration registry action." }, { status: 400 });
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
    const tooSoon = now - currentFile.registry.lastAutoWakeAt < WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS;
    if (!currentFile.registry.autoWakeEnabled || tooSoon || (activeLease && activeLease.ownerId !== normalizedOwnerId)) {
      return NextResponse.json({
        acquired: false,
        registry: currentFile.registry,
      }, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const nextRegistry = {
      ...currentFile.registry,
      lastAutoWakeAt: now,
    };
    await writeDiskFile(resolvedProject.id, {
      autoWakeLease: {
        expiresAt: now + AUTO_WAKE_LEASE_TTL_MS,
        ownerId: normalizedOwnerId,
      },
      registry: nextRegistry,
    });
    return NextResponse.json({
      acquired: true,
      registry: nextRegistry,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to claim Collaboration auto-run." }, { status: 400 });
  }
}
