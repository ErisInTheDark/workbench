/*
 * Exports:
 * - runtime/dynamic: keep agent-command capability reads on stateless uncached Node.js handlers. Keywords: agent, cli, capabilities, node.
 * - resolveWorkbenchAgentCliCapabilities: derive thread-aware CLI help audience from validated project Collaboration state. Keywords: agent, cli, help, collaboration, audience.
 * - POST: resolve the caller thread's CLI help audience from cwd-owned project state. Keywords: api, agent, cli, capabilities.
 */
import { NextRequest, NextResponse } from "next/server";

import type {
  WorkbenchAgentCliCapabilitiesRequest,
  WorkbenchAgentCliCapabilitiesResponse,
} from "../../../lib/workbench/cli/workbench-agent-cli-commands";
import { resolveAgentEndpointProjectFromCwd } from "../../../lib/workbench/project/agent-endpoint-project";
import { readCollaborationStateDiskFile } from "../collaboration/collaboration-state-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WorkbenchAgentCliCapabilityDependencies {
  readCollaborationRunThreadIds: (projectId: string) => Promise<readonly string[]>;
  resolveProjectIdFromCwd: (cwd: string) => Promise<string>;
}

const DEFAULT_DEPENDENCIES: WorkbenchAgentCliCapabilityDependencies = {
  readCollaborationRunThreadIds: async (projectId) => (
    (await readCollaborationStateDiskFile(projectId)).state.runThreadIds
  ),
  resolveProjectIdFromCwd: async (cwd) => (
    await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Agent command capabilities" })
  ).project.id,
};

function parseCapabilitiesRequest(value: unknown): WorkbenchAgentCliCapabilitiesRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("An agent command capabilities request object is required.");
  }
  const candidate = value as Record<string, unknown>;
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  const threadId = typeof candidate.threadId === "string" ? candidate.threadId.trim() : "";
  if (!cwd) {
    throw new Error("Agent command capabilities requires a cwd.");
  }
  if (!threadId) {
    throw new Error("Agent command capabilities requires a managed Workbench thread id.");
  }
  return { cwd, threadId };
}

export async function resolveWorkbenchAgentCliCapabilities(
  request: WorkbenchAgentCliCapabilitiesRequest,
  dependencies: WorkbenchAgentCliCapabilityDependencies = DEFAULT_DEPENDENCIES,
): Promise<WorkbenchAgentCliCapabilitiesResponse> {
  const projectId = await dependencies.resolveProjectIdFromCwd(request.cwd);
  const runThreadIds = await dependencies.readCollaborationRunThreadIds(projectId);
  return {
    helpAudience: runThreadIds.includes(request.threadId) ? "collaborator" : "default",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = parseCapabilitiesRequest(await request.json());
    return NextResponse.json(await resolveWorkbenchAgentCliCapabilities(body), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to resolve agent command capabilities.",
    }, {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
}
