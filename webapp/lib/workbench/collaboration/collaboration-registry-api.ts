/*
 * Exports:
 * - claimWorkbenchCollaborationAutoWake: compatibility auto-wake helper returning a v1 registry projection. Keywords: collaboration, auto-wake, lease, API.
 * - claimWorkbenchCollaborationStateAutoWake: ask the disk state to reserve one auto-wake run. Keywords: collaboration, auto-wake, state, API.
 * - mutateWorkbenchCollaborationAdminPost: apply a Workbench UI-admin Collaboration post mutation. Keywords: collaboration, admin posts, mutation, API.
 * - readWorkbenchCollaborationState: load project Collaboration threaded state from disk. Keywords: collaboration, state, API.
 * - readWorkbenchCollaborationThreadRegistry: compatibility v1 registry reader. Keywords: collaboration, registry, API.
 * - writeWorkbenchCollaborationState: persist project Collaboration threaded state. Keywords: collaboration, state, API.
 * - writeWorkbenchCollaborationThreadRegistry: compatibility v1 registry writer. Keywords: collaboration, registry, API.
 */

import type {
  WorkbenchCollaborationState,
  WorkbenchCollaborationThreadRegistry,
  WorkbenchCollaborationAdminPostMutation,
  WorkbenchCollaborationAdminPostMutationRequest,
  WorkbenchCollaborationAdminPostMutationResponse,
} from "../../types";
import { normalizeWorkbenchCollaborationThreadRegistry } from "./collaboration-registry";
import {
  normalizeWorkbenchCollaborationState,
  normalizeWorkbenchCollaborationThreadRegistryFromState,
} from "./collaboration-state";

interface CollaborationStateResponse {
  error?: string;
  registry?: unknown;
  state?: unknown;
}

interface AutoWakeResponse extends CollaborationStateResponse {
  acquired?: boolean;
}

function readError(payload: CollaborationStateResponse, fallback: string) {
  return typeof payload.error === "string" && payload.error.trim()
    ? payload.error
    : fallback;
}

function readPayloadState(payload: CollaborationStateResponse) {
  return normalizeWorkbenchCollaborationState(payload.state ?? payload.registry);
}

export async function readWorkbenchCollaborationState(projectId: string) {
  const response = await fetch(`/api/collaboration/registry?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as CollaborationStateResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to read the Collaboration state."));
  }

  return readPayloadState(payload);
}

export async function writeWorkbenchCollaborationState(
  projectId: string,
  state: WorkbenchCollaborationState,
) {
  const response = await fetch("/api/collaboration/registry", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId,
      state,
    }),
  });
  const payload = await response.json().catch(() => ({})) as CollaborationStateResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to save the Collaboration state."));
  }

  return readPayloadState(payload);
}

export async function claimWorkbenchCollaborationStateAutoWake(
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
    state: readPayloadState(payload),
  };
}

export async function mutateWorkbenchCollaborationAdminPost(
  projectId: string,
  mutation: WorkbenchCollaborationAdminPostMutation,
) {
  const body: WorkbenchCollaborationAdminPostMutationRequest = {
    mutation,
    projectId,
  };
  const response = await fetch("/api/collaboration/admin-posts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Partial<WorkbenchCollaborationAdminPostMutationResponse> & CollaborationStateResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to mutate the Collaboration posts."));
  }

  return readPayloadState(payload);
}

export async function readWorkbenchCollaborationThreadRegistry(projectId: string) {
  return normalizeWorkbenchCollaborationThreadRegistryFromState(await readWorkbenchCollaborationState(projectId));
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
      registry: normalizeWorkbenchCollaborationThreadRegistry(registry),
    }),
  });
  const payload = await response.json().catch(() => ({})) as CollaborationStateResponse;
  if (!response.ok) {
    throw new Error(readError(payload, "Unable to save the Collaboration registry."));
  }

  return normalizeWorkbenchCollaborationThreadRegistryFromState(readPayloadState(payload));
}

export async function claimWorkbenchCollaborationAutoWake(
  projectId: string,
  ownerId: string,
) {
  const result = await claimWorkbenchCollaborationStateAutoWake(projectId, ownerId);
  return {
    acquired: result.acquired,
    registry: normalizeWorkbenchCollaborationThreadRegistryFromState(result.state),
  };
}
