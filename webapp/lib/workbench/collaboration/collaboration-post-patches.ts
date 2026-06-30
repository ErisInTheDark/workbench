/*
 * Exports:
 * - WorkbenchCollaborationPostPatchApplyResult: result of applying collaborator post patches. Keywords: collaboration, patch, result.
 * - WorkbenchCollaborationPostPatchResult: parsed collaborator post patch payload. Keywords: collaboration, JSON, patch.
 * - applyWorkbenchCollaborationPostPatch: apply collaborator JSON mutations with permission guards. Keywords: collaboration, posts, patch.
 * - findWorkbenchCollaborationPostPatch: scan a thread payload for the latest post patch. Keywords: collaboration, thread, final response.
 * - parseWorkbenchCollaborationPostPatch: parse collaborator final JSON. Keywords: collaboration, JSON, parse.
 */

import type {
  ThreadPayload,
  WorkbenchCollaborationPostPatch,
  WorkbenchCollaborationState,
} from "../../types";
import { normalizeWorkbenchCollaborationPatchId, normalizeWorkbenchCollaborationState } from "./collaboration-state";
import {
  createCollaborationPost,
  hardDeleteCollaborationAgentLeaf,
  isCollaborationLeafPost,
  isEditableAgentLeafPost,
  updateCollaborationPost,
} from "./collaboration-tree-mutations";

export type WorkbenchCollaborationPostPatchMap = Record<string, WorkbenchCollaborationPostPatch | null>;

export interface WorkbenchCollaborationPostPatchResult {
  readonly memory: string;
  readonly posts: WorkbenchCollaborationPostPatchMap;
  readonly signature: string;
}

export interface WorkbenchCollaborationPostPatchApplyResult {
  readonly appliedCount: number;
  readonly state: WorkbenchCollaborationState;
  readonly warnings: string[];
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function createPatchSignature(thread: ThreadPayload, turnIndex: number, itemIndex: number, text: string) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }

  return `${thread.id}:${turnIndex}:${itemIndex}:${(hash >>> 0).toString(36)}`;
}

function normalizePatchEntry(value: unknown): WorkbenchCollaborationPostPatch | null | undefined {
  if (value === null) {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const body = typeof candidate.body === "string" ? candidate.body : "";
  if (!body.trim()) {
    return undefined;
  }

  const parentId = normalizeText(candidate.parentId);
  const prompt = normalizeText(candidate.prompt);
  return {
    body,
    ...(parentId ? { parentId } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

export function parseWorkbenchCollaborationPostPatch(value: string): WorkbenchCollaborationPostPatchResult | null {
  const body = stripJsonFence(value);
  if (!body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const rawPosts = candidate.posts;
  if (!rawPosts || typeof rawPosts !== "object" || Array.isArray(rawPosts)) {
    return null;
  }

  const posts: WorkbenchCollaborationPostPatchMap = {};
  for (const [rawId, rawEntry] of Object.entries(rawPosts as Record<string, unknown>)) {
    const id = normalizeWorkbenchCollaborationPatchId(rawId);
    if (!id) {
      continue;
    }

    const entry = normalizePatchEntry(rawEntry);
    if (entry !== undefined) {
      posts[id] = entry;
    }
  }

  return {
    memory: normalizeText(candidate.memory) || normalizeText(candidate.summary),
    posts,
    signature: "",
  };
}

function getPatchBuckets(patch: WorkbenchCollaborationPostPatchMap) {
  const deletes: string[] = [];
  const edits: Array<[string, WorkbenchCollaborationPostPatch]> = [];
  const creates: Array<[string, WorkbenchCollaborationPostPatch]> = [];

  for (const [id, entry] of Object.entries(patch)) {
    if (entry === null) {
      deletes.push(id);
      continue;
    }

    if (entry.parentId) {
      creates.push([id, entry]);
    } else {
      edits.push([id, entry]);
    }
  }

  return { creates, deletes, edits };
}

export function applyWorkbenchCollaborationPostPatch(
  state: WorkbenchCollaborationState,
  result: WorkbenchCollaborationPostPatchResult,
  now = Date.now(),
): WorkbenchCollaborationPostPatchApplyResult {
  let nextState = normalizeWorkbenchCollaborationState(state);
  const warnings: string[] = [];
  let appliedCount = 0;

  if (result.signature && nextState.lastAppliedPostPatchSignature === result.signature) {
    return {
      appliedCount,
      state: nextState,
      warnings,
    };
  }

  const { creates, deletes, edits } = getPatchBuckets(result.posts);

  for (const postId of deletes) {
    if (!isEditableAgentLeafPost(nextState, postId)) {
      warnings.push(`Ignored delete for non-editable agent leaf post: ${postId}`);
      continue;
    }

    nextState = hardDeleteCollaborationAgentLeaf(nextState, postId);
    appliedCount += 1;
  }

  for (const [postId, entry] of edits) {
    const post = nextState.posts[postId];
    if (!post) {
      warnings.push(`Ignored edit for unknown post: ${postId}`);
      continue;
    }
    if (!isEditableAgentLeafPost(nextState, postId)) {
      warnings.push(`Ignored edit for non-editable agent leaf post: ${postId}`);
      continue;
    }

    nextState = updateCollaborationPost(nextState, postId, {
      body: entry.body,
      prompt: entry.prompt,
    }, {
      now,
      revisionSource: "agent",
    });
    if (!entry.prompt && nextState.posts[postId]?.promptThreadId) {
      nextState = normalizeWorkbenchCollaborationState({
        ...nextState,
        posts: {
          ...nextState.posts,
          [postId]: {
            ...nextState.posts[postId]!,
            promptThreadId: undefined,
          },
        },
      });
    }
    appliedCount += 1;
  }

  for (const [postId, entry] of creates) {
    const parentId = entry.parentId ? normalizeWorkbenchCollaborationPatchId(entry.parentId) : "";
    const parent = parentId ? nextState.posts[parentId] : null;
    if (!parent) {
      warnings.push(`Ignored create with unknown parent: ${postId}`);
      continue;
    }
    if (parent.author !== "user" || !isCollaborationLeafPost(nextState, parentId)) {
      warnings.push(`Ignored create under non-user leaf parent: ${postId}`);
      continue;
    }
    if (nextState.posts[postId]) {
      warnings.push(`Ignored create for existing post id: ${postId}`);
      continue;
    }

    nextState = createCollaborationPost(nextState, parentId, {
      body: entry.body,
      prompt: entry.prompt,
    }, {
      author: "agent",
      id: postId,
      now,
    });
    appliedCount += 1;
  }

  return {
    appliedCount,
    state: normalizeWorkbenchCollaborationState({
      ...nextState,
      lastAppliedPostPatchSignature: result.signature || nextState.lastAppliedPostPatchSignature,
      lastRunMemory: result.memory || nextState.lastRunMemory,
    }),
    warnings,
  };
}

export function findWorkbenchCollaborationPostPatch(thread: ThreadPayload) {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (item.type !== "agentMessage") {
        continue;
      }

      const result = parseWorkbenchCollaborationPostPatch(item.text);
      if (result) {
        return {
          ...result,
          signature: createPatchSignature(thread, turnIndex, itemIndex, item.text),
        };
      }
    }
  }

  return null;
}
