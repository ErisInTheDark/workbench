/*
 * Exports:
 * - runtime/dynamic: force Collaboration post mutations onto Node.js without static caching. Keywords: collaboration, posts, node.
 * - GET/POST: describe and apply collaborator-safe post mutations. Keywords: collaboration, posts, mutate, API.
 */

import { NextRequest, NextResponse } from "next/server";

import { resolveProjectRoot } from "../../../../lib/project";
import type {
  WorkbenchCollaborationPostEndpointStateResponse,
  WorkbenchCollaborationPostEndpointUsage,
  WorkbenchCollaborationPostMutationRequest,
  WorkbenchCollaborationPostMutationResponse,
  WorkbenchCollaborationState,
} from "../../../../lib/types";
import {
  createWorkbenchCollaborationAgentPostId,
  normalizeWorkbenchCollaborationPatchId,
} from "../../../../lib/workbench/collaboration/collaboration-state";
import {
  createCollaborationPost,
  hardDeleteCollaborationAgentLeaf,
  isCollaborationLeafPost,
  isEditableAgentLeafPost,
  updateCollaborationPost,
} from "../../../../lib/workbench/collaboration/collaboration-tree-mutations";
import {
  readCollaborationStateDiskFile,
  writeCollaborationStateDiskFile,
} from "../collaboration-state-file";
import { notifyCollaborationStateUpdated } from "../collaboration-state-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT_USAGE: WorkbenchCollaborationPostEndpointUsage = {
  endpoint: "/api/collaboration/posts",
  rules: [
    "GET with projectId to inspect current Collaboration state before mutating.",
    "POST create with projectId, action=create, parentId, body, optional postId, optional prompt.",
    "POST update with projectId, action=update, postId, body, optional prompt; omit prompt to preserve it, send prompt=null to clear it.",
    "POST delete with projectId, action=delete, postId.",
    "Create is allowed only under user-authored leaf posts.",
    "Update and delete are allowed only for agent-authored leaf posts.",
  ],
};

interface ParsedMutationRequest {
  readonly projectId: string;
  readonly request: WorkbenchCollaborationPostMutationRequest;
}

function stateResponse(projectId: string, state: WorkbenchCollaborationState): WorkbenchCollaborationPostEndpointStateResponse {
  return {
    projectId,
    state,
    usage: ENDPOINT_USAGE,
  };
}

function normalizeBody(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePrompt(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeOptionalPostId(value: unknown) {
  return typeof value === "string"
    ? normalizeWorkbenchCollaborationPatchId(value)
    : "";
}

function parseMutationRequest(value: unknown): ParsedMutationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A Collaboration post mutation request object is required.");
  }

  const candidate = value as Record<string, unknown>;
  const projectId = typeof candidate.projectId === "string" ? candidate.projectId.trim() : "";
  const action = typeof candidate.action === "string" ? candidate.action.trim() : "";
  if (!projectId) {
    throw new Error("A projectId is required.");
  }

  if (action === "create") {
    const parentId = normalizeOptionalPostId(candidate.parentId);
    const postId = normalizeOptionalPostId(candidate.postId);
    const body = normalizeBody(candidate.body);
    const prompt = normalizePrompt(candidate.prompt);
    if (!parentId) {
      throw new Error("A parentId is required to create a Collaboration post.");
    }
    if (!body) {
      throw new Error("A body is required to create a Collaboration post.");
    }

    return {
      projectId,
      request: {
        action,
        body,
        parentId,
        ...(postId ? { postId } : {}),
        ...(typeof prompt === "string" && prompt ? { prompt } : {}),
      },
    };
  }

  if (action === "update") {
    const postId = normalizeOptionalPostId(candidate.postId);
    const body = normalizeBody(candidate.body);
    const prompt = normalizePrompt(candidate.prompt);
    if (!postId) {
      throw new Error("A postId is required to update a Collaboration post.");
    }
    if (!body) {
      throw new Error("A body is required to update a Collaboration post.");
    }

    return {
      projectId,
      request: {
        action,
        body,
        postId,
        ...(prompt !== undefined ? { prompt } : {}),
      },
    };
  }

  if (action === "delete") {
    const postId = normalizeOptionalPostId(candidate.postId);
    if (!postId) {
      throw new Error("A postId is required to delete a Collaboration post.");
    }

    return {
      projectId,
      request: {
        action,
        postId,
      },
    };
  }

  throw new Error("Unsupported Collaboration post mutation action.");
}

function createMutationResponse(
  projectId: string,
  state: WorkbenchCollaborationState,
  action: WorkbenchCollaborationPostMutationRequest["action"],
  message: string,
  postId?: string,
): WorkbenchCollaborationPostMutationResponse {
  const post = postId ? state.posts[postId] : undefined;
  return {
    ...stateResponse(projectId, state),
    action,
    message,
    ok: true,
    ...(post ? { post } : {}),
    ...(postId ? { postId } : {}),
  };
}

function createPost(state: WorkbenchCollaborationState, request: Extract<WorkbenchCollaborationPostMutationRequest, { action: "create" }>) {
  const parent = state.posts[request.parentId];
  if (!parent) {
    throw new Error(`Cannot create Collaboration post: parent ${request.parentId} does not exist.`);
  }
  if (parent.author !== "user" || !isCollaborationLeafPost(state, request.parentId)) {
    throw new Error(`Cannot create Collaboration post under ${request.parentId}: parent must be a user-authored leaf post.`);
  }

  const postId = request.postId || createWorkbenchCollaborationAgentPostId();
  if (state.posts[postId]) {
    throw new Error(`Cannot create Collaboration post: post id ${postId} already exists.`);
  }

  return {
    postId,
    state: createCollaborationPost(state, request.parentId, {
      body: request.body,
      prompt: request.prompt,
    }, {
      author: "agent",
      id: postId,
    }),
  };
}

function updatePost(state: WorkbenchCollaborationState, request: Extract<WorkbenchCollaborationPostMutationRequest, { action: "update" }>) {
  const post = state.posts[request.postId];
  if (!post) {
    throw new Error(`Cannot update Collaboration post: post ${request.postId} does not exist.`);
  }
  if (!isEditableAgentLeafPost(state, request.postId)) {
    throw new Error(`Cannot update Collaboration post ${request.postId}: post must be an agent-authored leaf post.`);
  }

  return updateCollaborationPost(state, request.postId, {
    body: request.body,
    prompt: request.prompt === null ? undefined : request.prompt ?? post.prompt,
  }, {
    revisionSource: "agent",
  });
}

function deletePost(state: WorkbenchCollaborationState, request: Extract<WorkbenchCollaborationPostMutationRequest, { action: "delete" }>) {
  if (!state.posts[request.postId]) {
    throw new Error(`Cannot delete Collaboration post: post ${request.postId} does not exist.`);
  }
  if (!isEditableAgentLeafPost(state, request.postId)) {
    throw new Error(`Cannot delete Collaboration post ${request.postId}: post must be an agent-authored leaf post.`);
  }

  return hardDeleteCollaborationAgentLeaf(state, request.postId);
}

export async function GET(request: NextRequest) {
  try {
    const resolvedProject = await resolveProjectRoot(request.nextUrl.searchParams.get("projectId"));
    const file = await readCollaborationStateDiskFile(resolvedProject.id);
    return NextResponse.json(stateResponse(resolvedProject.id, file.state), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read Collaboration posts." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const mutation = parseMutationRequest(await request.json());
    const resolvedProject = await resolveProjectRoot(mutation.projectId);
    const currentFile = await readCollaborationStateDiskFile(resolvedProject.id, { allowCorruptRecovery: true });
    const currentState = currentFile.state;
    let nextState = currentState;
    let postId: string | undefined;

    if (mutation.request.action === "create") {
      const result = createPost(currentState, mutation.request);
      nextState = result.state;
      postId = result.postId;
    } else if (mutation.request.action === "update") {
      nextState = updatePost(currentState, mutation.request);
      postId = mutation.request.postId;
    } else {
      nextState = deletePost(currentState, mutation.request);
      postId = mutation.request.postId;
    }

    await writeCollaborationStateDiskFile(resolvedProject.id, {
      autoWakeLease: currentFile.autoWakeLease,
      state: nextState,
    });
    await notifyCollaborationStateUpdated(request, resolvedProject.id, nextState);

    return NextResponse.json(createMutationResponse(
      resolvedProject.id,
      nextState,
      mutation.request.action,
      `Collaboration post ${mutation.request.action} applied.`,
      postId,
    ), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to mutate Collaboration posts." }, { status: 400 });
  }
}
