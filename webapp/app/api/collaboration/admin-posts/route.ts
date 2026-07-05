/*
 * Exports:
 * - runtime/dynamic: force admin Collaboration post mutations onto Node.js without static caching. Keywords: collaboration, admin posts, node.
 * - POST: apply Workbench UI-admin Collaboration post mutations. Keywords: collaboration, admin posts, mutate, API.
 */

import { NextRequest, NextResponse } from "next/server";

import { resolveProjectRoot } from "../../../../lib/project";
import type {
  WorkbenchCollaborationState,
  WorkbenchCollaborationAdminPostMutation,
  WorkbenchCollaborationAdminPostMutationResponse,
  WorkbenchThreadComposerAttachmentDraft,
} from "../../../../lib/types";
import {
  createCollaborationPost,
  createCollaborationStateTag,
  deleteCollaborationSubtree,
  materializeCollaborationPostPromptThread,
  moveCollaborationPost,
  removeCollaborationPostTag,
  restoreCollaborationPostRevision,
  setCollaborationPostCollapsed,
  tagCollaborationPost,
  updateCollaborationPost,
  updateCollaborationPostPrompt,
} from "../../../../lib/workbench/collaboration/collaboration-tree-mutations";
import {
  readCollaborationStateDiskFile,
  writeCollaborationStateDiskFile,
} from "../collaboration-state-file";
import { notifyCollaborationStateUpdated } from "../collaboration-state-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function normalizeNullablePostId(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeAttachments(value: unknown): WorkbenchThreadComposerAttachmentDraft[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value.flatMap((entry): WorkbenchThreadComposerAttachmentDraft[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = normalizeText(entry.id).trim();
    const url = normalizeText(entry.url).trim();
    return id && url ? [{ id, url }] : [];
  });

  return attachments.length ? attachments : undefined;
}

function normalizeMoveIntent(value: unknown): Extract<WorkbenchCollaborationAdminPostMutation, { action: "movePost" }>["intent"] | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = normalizeText(value.type);
  const targetPostId = normalizeText(value.targetPostId).trim();
  if (!targetPostId || (type !== "after" && type !== "before" && type !== "inside")) {
    return null;
  }

  return { type, targetPostId };
}

function parseMutation(value: unknown): WorkbenchCollaborationAdminPostMutation {
  if (!isRecord(value)) {
    throw new Error("A Collaboration admin post mutation object is required.");
  }

  const action = normalizeText(value.action);
  if (action === "createPost") {
    const postId = normalizeText(value.postId).trim();
    if (!postId) {
      throw new Error("A postId is required to create a Collaboration post.");
    }

    return {
      action,
      body: normalizeText(value.body),
      parentId: normalizeNullablePostId(value.parentId),
      postId,
      ...(normalizeAttachments(value.attachments) ? { attachments: normalizeAttachments(value.attachments) } : {}),
      ...(normalizeOptionalText(value.prompt) ? { prompt: normalizeOptionalText(value.prompt) } : {}),
    };
  }

  if (action === "createTag") {
    const tag = normalizeText(value.tag);
    if (!tag.trim()) {
      throw new Error("A tag is required to create a Collaboration tag.");
    }

    return { action, tag };
  }

  if (action === "deletePost") {
    const postId = normalizeText(value.postId).trim();
    if (!postId) {
      throw new Error("A postId is required to delete a Collaboration post.");
    }

    return { action, postId };
  }

  if (action === "materializePromptThread") {
    const postId = normalizeText(value.postId).trim();
    const promptThreadId = normalizeText(value.promptThreadId).trim();
    if (!postId || !promptThreadId) {
      throw new Error("A postId and promptThreadId are required to materialize a Collaboration prompt thread.");
    }

    return {
      action,
      postId,
      prompt: normalizeText(value.prompt),
      promptThreadId,
    };
  }

  if (action === "movePost") {
    const postId = normalizeText(value.postId).trim();
    const intent = normalizeMoveIntent(value.intent);
    if (!postId || !intent) {
      throw new Error("A postId and valid move intent are required to move a Collaboration post.");
    }

    return { action, intent, postId };
  }

  if (action === "removePostTag") {
    const postId = normalizeText(value.postId).trim();
    const tag = normalizeText(value.tag);
    if (!postId || !tag.trim()) {
      throw new Error("A postId and tag are required to remove a Collaboration post tag.");
    }

    return { action, postId, tag };
  }

  if (action === "restorePostRevision") {
    const postId = normalizeText(value.postId).trim();
    const revisionId = normalizeText(value.revisionId).trim();
    if (!postId || !revisionId) {
      throw new Error("A postId and revisionId are required to restore a Collaboration post revision.");
    }

    return { action, postId, revisionId };
  }

  if (action === "setPostCollapsed") {
    const postId = normalizeText(value.postId).trim();
    if (!postId) {
      throw new Error("A postId is required to collapse or expand a Collaboration post.");
    }

    return {
      action,
      isCollapsed: value.isCollapsed === true,
      postId,
    };
  }

  if (action === "tagPost") {
    const postId = normalizeText(value.postId).trim();
    const tag = normalizeText(value.tag);
    if (!postId || !tag.trim()) {
      throw new Error("A postId and tag are required to tag a Collaboration post.");
    }

    return { action, postId, tag };
  }

  if (action === "updatePost") {
    const postId = normalizeText(value.postId).trim();
    if (!postId) {
      throw new Error("A postId is required to update a Collaboration post.");
    }

    return {
      action,
      body: normalizeText(value.body),
      postId,
      ...(normalizeAttachments(value.attachments) ? { attachments: normalizeAttachments(value.attachments) } : {}),
      ...(normalizeOptionalText(value.prompt) ? { prompt: normalizeOptionalText(value.prompt) } : {}),
    };
  }

  if (action === "updatePostPrompt") {
    const postId = normalizeText(value.postId).trim();
    const prompt = normalizeText(value.prompt).trim();
    if (!postId || !prompt) {
      throw new Error("A postId and prompt are required to update a Collaboration post prompt.");
    }

    return {
      action,
      postId,
      prompt,
    };
  }

  throw new Error("Unsupported Collaboration admin post mutation action.");
}

function parseRequest(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("A Collaboration admin post mutation request object is required.");
  }

  const projectId = normalizeText(value.projectId).trim();
  if (!projectId) {
    throw new Error("A projectId is required.");
  }

  return {
    mutation: parseMutation(value.mutation),
    projectId,
  };
}

function applyMutation(
  state: WorkbenchCollaborationState,
  mutation: WorkbenchCollaborationAdminPostMutation,
) {
  switch (mutation.action) {
    case "createPost":
      return createCollaborationPost(state, mutation.parentId, {
        attachments: mutation.attachments,
        body: mutation.body,
        prompt: mutation.prompt,
      }, {
        id: mutation.postId,
      });
    case "createTag":
      return createCollaborationStateTag(state, mutation.tag);
    case "deletePost":
      return deleteCollaborationSubtree(state, mutation.postId);
    case "materializePromptThread":
      return materializeCollaborationPostPromptThread(state, mutation.postId, mutation.prompt, mutation.promptThreadId);
    case "movePost":
      return moveCollaborationPost(state, mutation.postId, mutation.intent);
    case "removePostTag":
      return removeCollaborationPostTag(state, mutation.postId, mutation.tag);
    case "restorePostRevision":
      return restoreCollaborationPostRevision(state, mutation.postId, mutation.revisionId);
    case "setPostCollapsed":
      return setCollaborationPostCollapsed(state, mutation.postId, mutation.isCollapsed);
    case "tagPost":
      return tagCollaborationPost(state, mutation.postId, mutation.tag);
    case "updatePost":
      return updateCollaborationPost(state, mutation.postId, {
        attachments: mutation.attachments,
        body: mutation.body,
        prompt: mutation.prompt,
      });
    case "updatePostPrompt":
      return updateCollaborationPostPrompt(state, mutation.postId, mutation.prompt);
  }
}

function createMutationResponse(
  projectId: string,
  state: WorkbenchCollaborationState,
  mutation: WorkbenchCollaborationAdminPostMutation,
): WorkbenchCollaborationAdminPostMutationResponse {
  return {
    mutation,
    ok: true,
    projectId,
    state,
  };
}

export async function POST(request: NextRequest) {
  try {
    const mutationRequest = parseRequest(await request.json());
    const resolvedProject = await resolveProjectRoot(mutationRequest.projectId);
    const currentFile = await readCollaborationStateDiskFile(resolvedProject.id, { allowCorruptRecovery: true });
    const nextState = applyMutation(currentFile.state, mutationRequest.mutation);

    await writeCollaborationStateDiskFile(resolvedProject.id, {
      autoWakeLease: currentFile.autoWakeLease,
      state: nextState,
    });
    await notifyCollaborationStateUpdated(request, resolvedProject.id, nextState);

    return NextResponse.json(createMutationResponse(resolvedProject.id, nextState, mutationRequest.mutation), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to mutate Collaboration posts." }, { status: 400 });
  }
}
