/*
 * Exports:
 * - canMoveCollaborationPost: report whether a post can move to a drop intent. Keywords: collaboration, tree, move.
 * - createCollaborationPost: add a root or child post. Keywords: collaboration, tree, create.
 * - createCollaborationStateTag: add a project-level Collaboration tag. Keywords: collaboration, tag, create.
 * - deleteCollaborationSubtree: hard-delete a user-selected post subtree. Keywords: collaboration, tree, delete.
 * - hardDeleteCollaborationAgentLeaf: hard-delete an editable agent leaf. Keywords: collaboration, agent, delete.
 * - isCollaborationLeafPost: report whether a post has no children. Keywords: collaboration, leaf.
 * - isEditableAgentLeafPost: report whether collaborator can edit/delete a post. Keywords: collaboration, agent, leaf.
 * - materializeCollaborationPostPromptThread: attach a started prompt thread to a post. Keywords: collaboration, prompt, thread, materialize.
 * - moveCollaborationPost: move a post before, after, or inside another post. Keywords: collaboration, tree, reorder.
 * - removeCollaborationPostTag: remove a tag assignment from a Collaboration post. Keywords: collaboration, post, tag.
 * - restoreCollaborationPostRevision: restore a prior visible version and append a restore revision. Keywords: collaboration, revisions.
 * - setCollaborationPostCollapsed: persist expanded or collapsed UI state for a post. Keywords: collaboration, post, collapse, expand.
 * - tagCollaborationPost: assign a project-level tag to a Collaboration post. Keywords: collaboration, post, tag.
 * - updateCollaborationPost: update visible post content and append previous state revision. Keywords: collaboration, edit, revisions.
 * - updateCollaborationPostPrompt: update only a post's suggested prompt with optional stale-save guard. Keywords: collaboration, prompt, save.
 */

import type {
  WorkbenchCollaborationPost,
  WorkbenchCollaborationPostRevision,
  WorkbenchCollaborationPostRevisionSource,
  WorkbenchCollaborationState,
  WorkbenchThreadComposerAttachmentDraft,
} from "../../types";
import {
  createWorkbenchCollaborationPostId,
  createWorkbenchCollaborationRevisionId,
  normalizeWorkbenchCollaborationTag,
  normalizeWorkbenchCollaborationState,
  touchWorkbenchCollaborationState,
} from "./collaboration-state";

export type CollaborationPostDropIntent =
  | { type: "after"; targetPostId: string }
  | { type: "before"; targetPostId: string }
  | { type: "inside"; targetPostId: string };

export interface WorkbenchCollaborationPostDraft {
  attachments?: WorkbenchThreadComposerAttachmentDraft[];
  body: string;
  prompt?: string;
}

function withoutId(ids: readonly string[], postId: string) {
  return ids.filter((id) => id !== postId);
}

function tagKey(tag: string) {
  return tag.toLocaleLowerCase();
}

function hasTag(tags: readonly string[], tag: string) {
  const key = tagKey(tag);
  return tags.some((candidate) => tagKey(candidate) === key);
}

function withoutTag(tags: readonly string[], tag: string) {
  const key = tagKey(tag);
  return tags.filter((candidate) => tagKey(candidate) !== key);
}

function insertAround(ids: readonly string[], targetId: string, postId: string, placement: "after" | "before") {
  const nextIds = withoutId(ids, postId);
  const targetIndex = nextIds.indexOf(targetId);
  if (targetIndex < 0) {
    return nextIds;
  }

  const insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
  return [
    ...nextIds.slice(0, insertIndex),
    postId,
    ...nextIds.slice(insertIndex),
  ];
}

function createRevision(
  post: WorkbenchCollaborationPost,
  source: WorkbenchCollaborationPostRevisionSource,
  now: number,
): WorkbenchCollaborationPostRevision {
  return {
    attachments: post.attachments,
    body: post.body,
    createdAt: now,
    id: createWorkbenchCollaborationRevisionId(),
    prompt: post.prompt,
    source,
  };
}

function applyDraftToPost(
  post: WorkbenchCollaborationPost,
  draft: WorkbenchCollaborationPostDraft,
  now: number,
) {
  return {
    ...post,
    attachments: draft.attachments?.length ? draft.attachments : undefined,
    body: draft.body,
    prompt: draft.prompt?.trim() ? draft.prompt.trim() : undefined,
    updatedAt: now,
  };
}

function isDescendantPost(
  state: WorkbenchCollaborationState,
  postId: string,
  possibleDescendantId: string,
): boolean {
  const post = state.posts[postId];
  if (!post) {
    return false;
  }

  for (const childId of post.childIds) {
    if (childId === possibleDescendantId || isDescendantPost(state, childId, possibleDescendantId)) {
      return true;
    }
  }

  return false;
}

function collectSubtreeIds(state: WorkbenchCollaborationState, postId: string): string[] {
  const post = state.posts[postId];
  if (!post) {
    return [];
  }

  return [
    postId,
    ...post.childIds.flatMap((childId) => collectSubtreeIds(state, childId)),
  ];
}

export function isCollaborationLeafPost(state: WorkbenchCollaborationState, postId: string) {
  const post = state.posts[postId];
  return Boolean(post) && post.childIds.length === 0;
}

export function isEditableAgentLeafPost(state: WorkbenchCollaborationState, postId: string) {
  const post = state.posts[postId];
  return Boolean(post) && post.author === "agent" && isCollaborationLeafPost(state, postId);
}

export function createCollaborationPost(
  state: WorkbenchCollaborationState,
  parentId: string | null,
  draft: WorkbenchCollaborationPostDraft,
  options: {
    author?: "agent" | "user";
    id?: string;
    now?: number;
  } = {},
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const now = options.now ?? Date.now();
  const id = options.id ?? createWorkbenchCollaborationPostId();
  const parent = parentId ? normalizedState.posts[parentId] : null;
  if (parentId && !parent) {
    return normalizedState;
  }

  const post: WorkbenchCollaborationPost = {
    attachments: draft.attachments?.length ? draft.attachments : undefined,
    author: options.author ?? "user",
    body: draft.body,
    childIds: [],
    createdAt: now,
    id,
    parentId,
    prompt: draft.prompt?.trim() ? draft.prompt.trim() : undefined,
    revisions: [],
    tags: [],
    updatedAt: now,
  };
  const posts = {
    ...normalizedState.posts,
    [id]: post,
    ...(parent ? {
      [parent.id]: {
        ...parent,
        childIds: [...parent.childIds, id],
      },
    } : {}),
  };

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts,
    rootPostIds: parent ? normalizedState.rootPostIds : [...normalizedState.rootPostIds, id],
  }), now);
}

export function updateCollaborationPost(
  state: WorkbenchCollaborationState,
  postId: string,
  draft: WorkbenchCollaborationPostDraft,
  options: {
    revisionSource?: WorkbenchCollaborationPostRevisionSource;
    now?: number;
  } = {},
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  if (!post) {
    return normalizedState;
  }

  const now = options.now ?? Date.now();
  const nextPost = applyDraftToPost(post, draft, now);
  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: {
        ...nextPost,
        revisions: [
          ...post.revisions,
          createRevision(post, options.revisionSource ?? post.author, now),
        ],
      },
    },
  }), now);
}

export function updateCollaborationPostPrompt(
  state: WorkbenchCollaborationState,
  postId: string,
  prompt: string,
  options: {
    basePostUpdatedAt?: number;
    basePrompt?: string;
    now?: number;
  } = {},
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  const normalizedPrompt = prompt.trim();
  if (!post || !normalizedPrompt || post.prompt === normalizedPrompt) {
    return normalizedState;
  }

  const basePrompt = options.basePrompt?.trim();
  const hasBasePostUpdatedAt = typeof options.basePostUpdatedAt === "number" && Number.isFinite(options.basePostUpdatedAt);
  const basePostUpdatedAt = hasBasePostUpdatedAt ? Math.trunc(options.basePostUpdatedAt as number) : 0;
  if (
    (basePrompt !== undefined && (post.prompt?.trim() ?? "") !== basePrompt)
    || (hasBasePostUpdatedAt && post.updatedAt !== basePostUpdatedAt)
  ) {
    return normalizedState;
  }

  const now = options.now ?? Date.now();
  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: {
        ...post,
        prompt: normalizedPrompt,
        updatedAt: now,
      },
    },
  }), now);
}

export function restoreCollaborationPostRevision(
  state: WorkbenchCollaborationState,
  postId: string,
  revisionId: string,
  now = Date.now(),
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  const revision = post?.revisions.find((candidate) => candidate.id === revisionId);
  if (!post || !revision) {
    return normalizedState;
  }

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: {
        ...post,
        attachments: revision.attachments,
        body: revision.body,
        prompt: revision.prompt,
        revisions: [
          ...post.revisions,
          createRevision(post, "restore", now),
        ],
        updatedAt: now,
      },
    },
  }), now);
}

export function setCollaborationPostCollapsed(
  state: WorkbenchCollaborationState,
  postId: string,
  isCollapsed: boolean,
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  if (!post || (post.isCollapsed === true) === isCollapsed) {
    return normalizedState;
  }

  const nextPost = {
    ...post,
    isCollapsed: isCollapsed ? true : undefined,
  };
  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: nextPost,
    },
  }));
}

export function materializeCollaborationPostPromptThread(
  state: WorkbenchCollaborationState,
  postId: string,
  prompt: string,
  promptThreadId: string,
  now = Date.now(),
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  const normalizedPrompt = prompt.trim();
  const normalizedPromptThreadId = promptThreadId.trim();
  if (!post || !normalizedPromptThreadId) {
    return normalizedState;
  }

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: {
        ...post,
        prompt: normalizedPrompt || post.prompt,
        promptThreadId: normalizedPromptThreadId,
        updatedAt: now,
      },
    },
  }), now);
}

export function deleteCollaborationSubtree(state: WorkbenchCollaborationState, postId: string) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  if (!post) {
    return normalizedState;
  }

  const deleteIds = new Set(collectSubtreeIds(normalizedState, postId));
  const posts = Object.fromEntries(
    Object.entries(normalizedState.posts)
      .filter(([candidateId]) => !deleteIds.has(candidateId))
      .map(([candidateId, candidatePost]) => [candidateId, {
        ...candidatePost,
        childIds: candidatePost.childIds.filter((childId) => !deleteIds.has(childId)),
      }]),
  );

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts,
    rootPostIds: normalizedState.rootPostIds.filter((rootPostId) => !deleteIds.has(rootPostId)),
  }));
}

export function hardDeleteCollaborationAgentLeaf(state: WorkbenchCollaborationState, postId: string) {
  return isEditableAgentLeafPost(state, postId)
    ? deleteCollaborationSubtree(state, postId)
    : normalizeWorkbenchCollaborationState(state);
}

export function canMoveCollaborationPost(
  state: WorkbenchCollaborationState,
  postId: string,
  intent: CollaborationPostDropIntent,
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  const target = normalizedState.posts[intent.targetPostId];
  if (!post || !target || postId === intent.targetPostId) {
    return false;
  }

  return !isDescendantPost(normalizedState, postId, intent.targetPostId);
}

export function moveCollaborationPost(
  state: WorkbenchCollaborationState,
  postId: string,
  intent: CollaborationPostDropIntent,
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  if (!canMoveCollaborationPost(normalizedState, postId, intent)) {
    return normalizedState;
  }

  const post = normalizedState.posts[postId]!;
  const sourceParent = post.parentId ? normalizedState.posts[post.parentId] : null;
  const target = normalizedState.posts[intent.targetPostId]!;
  const nextPosts = { ...normalizedState.posts };
  let rootPostIds = withoutId(normalizedState.rootPostIds, postId);

  if (sourceParent) {
    nextPosts[sourceParent.id] = {
      ...sourceParent,
      childIds: withoutId(sourceParent.childIds, postId),
    };
  }

  if (intent.type === "inside") {
    nextPosts[target.id] = {
      ...target,
      childIds: [...withoutId(target.childIds, postId), postId],
    };
    nextPosts[postId] = {
      ...post,
      parentId: target.id,
    };
  } else {
    const targetParent = target.parentId ? nextPosts[target.parentId] : null;
    if (targetParent) {
      nextPosts[targetParent.id] = {
        ...targetParent,
        childIds: insertAround(targetParent.childIds, target.id, postId, intent.type),
      };
      nextPosts[postId] = {
        ...post,
        parentId: targetParent.id,
      };
    } else {
      rootPostIds = insertAround(rootPostIds, target.id, postId, intent.type);
      nextPosts[postId] = {
        ...post,
        parentId: null,
      };
    }
  }

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: nextPosts,
    rootPostIds,
  }));
}

export function createCollaborationStateTag(
  state: WorkbenchCollaborationState,
  tag: string,
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const normalizedTag = normalizeWorkbenchCollaborationTag(tag);
  if (!normalizedTag || hasTag(normalizedState.tags, normalizedTag)) {
    return normalizedState;
  }

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    tags: [...normalizedState.tags, normalizedTag],
  }));
}

export function tagCollaborationPost(
  state: WorkbenchCollaborationState,
  postId: string,
  tag: string,
  now = Date.now(),
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  const normalizedTag = normalizeWorkbenchCollaborationTag(tag);
  if (!post || !normalizedTag) {
    return normalizedState;
  }

  const stateTags = hasTag(normalizedState.tags, normalizedTag)
    ? normalizedState.tags
    : [...normalizedState.tags, normalizedTag];
  if (hasTag(post.tags, normalizedTag)) {
    return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
      ...normalizedState,
      tags: stateTags,
    }), now);
  }

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: {
        ...post,
        tags: [...post.tags, normalizedTag],
        updatedAt: now,
      },
    },
    tags: stateTags,
  }), now);
}

export function removeCollaborationPostTag(
  state: WorkbenchCollaborationState,
  postId: string,
  tag: string,
  now = Date.now(),
) {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const post = normalizedState.posts[postId];
  const normalizedTag = normalizeWorkbenchCollaborationTag(tag);
  if (!post || !normalizedTag || !hasTag(post.tags, normalizedTag)) {
    return normalizedState;
  }

  return touchWorkbenchCollaborationState(normalizeWorkbenchCollaborationState({
    ...normalizedState,
    posts: {
      ...normalizedState.posts,
      [postId]: {
        ...post,
        tags: withoutTag(post.tags, normalizedTag),
        updatedAt: now,
      },
    },
  }), now);
}
