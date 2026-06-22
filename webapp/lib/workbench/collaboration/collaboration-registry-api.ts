/*
 * Exports:
 * - claimWorkbenchCollaborationAutoWake: ask the disk registry to reserve one auto-wake run. Keywords: collaboration, auto-wake, lease, API.
 * - readWorkbenchCollaborationThreadRegistry: load a project Collaboration registry from disk. Keywords: collaboration, registry, API.
 * - writeWorkbenchCollaborationThreadRegistry: persist a project Collaboration registry to disk. Keywords: collaboration, registry, API.
 */

import type { WorkbenchCollaborationThreadRegistry } from "../../types";
import { normalizeWorkbenchCollaborationThreadRegistry } from "./collaboration-registry";

interface RegistryResponse {
  registry?: unknown;
  error?: string;
}

interface AutoWakeResponse extends RegistryResponse {
  acquired?: boolean;
}

function readError(payload: RegistryResponse, fallback: string) {
  return typeof payload.error === "string" && payload.error.trim()
    ? payload.error
    : fallback;
}

export async function readWorkbenchCollaborationThreadRegistry(projectId: string) {
  const response = await fetch(`/api/collaboration/registry?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as RegistryResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to read the Collaboration registry."));
  }

  return normalizeWorkbenchCollaborationThreadRegistry(payload.registry);
}

export async function writeWorkbenchCollaborationThreadRegistry(
  projectId: string,
  registry: WorkbenchCollaborationThreadRegistry,
) {
  const response = await fetch("/api/collaboration/registry", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId,
      registry,
    }),
  });
  const payload = await response.json().catch(() => ({})) as RegistryResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to save the Collaboration registry."));
  }

  return normalizeWorkbenchCollaborationThreadRegistry(payload.registry);
}

export async function claimWorkbenchCollaborationAutoWake(
  projectId: string,
  ownerId: string,
) {
  const response = await fetch("/api/collaboration/registry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "claimAutoWake",
      ownerId,
      projectId,
    }),
  });
  const payload = await response.json().catch(() => ({})) as AutoWakeResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to claim Collaboration auto-run."));
  }

  return {
    acquired: payload.acquired === true,
    registry: normalizeWorkbenchCollaborationThreadRegistry(payload.registry),
  };
}
