/*
 * Exports:
 * - runtime/dynamic: force Collaboration memory reads and writes onto Node.js without static caching. Keywords: collaboration, memory, node.
 * - GET/POST: inspect and replace private collaborator next-run memory. Keywords: collaboration, memory, API.
 */

import { NextRequest, NextResponse } from "next/server";

import { resolveProjectRoot } from "../../../../lib/project";
import type {
  WorkbenchCollaborationMemoryEndpointUsage,
  WorkbenchCollaborationMemoryMutationResponse,
  WorkbenchCollaborationMemorySetRequest,
  WorkbenchCollaborationMemoryStateResponse,
  WorkbenchCollaborationState,
} from "../../../../lib/types";
import {
  touchWorkbenchCollaborationState,
} from "../../../../lib/workbench/collaboration/collaboration-state";
import {
  readCollaborationStateDiskFile,
  writeCollaborationStateDiskFile,
} from "../collaboration-state-file";
import { notifyCollaborationStateUpdated } from "../collaboration-state-notifications";
import { resolveAgentEndpointProjectFromCwd } from "../../../../lib/workbench/project/agent-endpoint-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT_USAGE: WorkbenchCollaborationMemoryEndpointUsage = {
  endpoint: "/api/collaboration/memory",
  rules: [
    "GET with cwd to inspect the current private collaborator memory.",
    "POST with cwd and non-empty memory to replace private memory for the next collaborator run.",
    "POST with missing or empty memory preserves the existing private memory.",
    "Memory is private next-run context for the collaborator, not visible Collaboration tree content.",
    "When replacing memory, carry forward still-useful previous memory because the endpoint stores one replacement value.",
  ],
};

function stateResponse(projectId: string, state: WorkbenchCollaborationState): WorkbenchCollaborationMemoryStateResponse {
  return {
    memory: state.lastRunMemory,
    projectId,
    state,
    usage: ENDPOINT_USAGE,
  };
}

function mutationResponse(
  projectId: string,
  state: WorkbenchCollaborationState,
  preserved: boolean,
): WorkbenchCollaborationMemoryMutationResponse {
  return {
    ...stateResponse(projectId, state),
    message: preserved
      ? "Collaboration memory preserved."
      : "Collaboration memory replaced.",
    ok: true,
    preserved,
  };
}

function parseMemoryRequest(value: unknown): WorkbenchCollaborationMemorySetRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A Collaboration memory request object is required.");
  }

  const candidate = value as Record<string, unknown>;
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  const projectId = typeof candidate.projectId === "string" ? candidate.projectId.trim() : "";
  if (!cwd && !projectId) {
    throw new Error("A cwd is required.");
  }

  return {
    cwd,
    memory: typeof candidate.memory === "string" ? candidate.memory : null,
    projectId,
  };
}

function normalizeMemory(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveCollaborationMemoryProject({
  cwd,
  projectId,
}: {
  cwd?: string | null;
  projectId?: string | null;
}) {
  if (cwd) {
    return (await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Collaboration memory" })).project;
  }

  if (projectId) {
    return await resolveProjectRoot(projectId);
  }

  throw new Error("Collaboration memory requires a cwd.");
}

export async function GET(request: NextRequest) {
  try {
    const resolvedProject = await resolveCollaborationMemoryProject({
      cwd: request.nextUrl.searchParams.get("cwd"),
      projectId: request.nextUrl.searchParams.get("projectId"),
    });
    const file = await readCollaborationStateDiskFile(resolvedProject.id);
    return NextResponse.json(stateResponse(resolvedProject.id, file.state), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read Collaboration memory." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const memoryRequest = parseMemoryRequest(await request.json());
    const resolvedProject = await resolveCollaborationMemoryProject(memoryRequest);
    const currentFile = await readCollaborationStateDiskFile(resolvedProject.id, { allowCorruptRecovery: true });
    const memory = normalizeMemory(memoryRequest.memory);
    if (!memory) {
      return NextResponse.json(mutationResponse(resolvedProject.id, currentFile.state, true), {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const nextState: WorkbenchCollaborationState = touchWorkbenchCollaborationState({
      ...currentFile.state,
      lastAppliedRunMemorySignature: `memory-endpoint:${Date.now().toString(36)}`,
      lastRunMemory: memory,
    });
    await writeCollaborationStateDiskFile(resolvedProject.id, {
      autoWakeLease: currentFile.autoWakeLease,
      state: nextState,
    });
    await notifyCollaborationStateUpdated(request, resolvedProject.id, nextState);

    return NextResponse.json(mutationResponse(resolvedProject.id, nextState, false), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update Collaboration memory." }, { status: 400 });
  }
}
