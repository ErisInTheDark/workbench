/*
 * Exports:
 * - COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID: deterministic id for migrated scratchpad content. Keywords: collaboration, scratchpad, migration.
 * - EMPTY_WORKBENCH_COLLABORATION_STATE: canonical empty threaded Collaboration state. Keywords: collaboration, state, defaults.
 * - WORKBENCH_COLLABORATION_STATE_VERSION: current Collaboration state version. Keywords: collaboration, version.
 * - createWorkbenchCollaborationAgentPostId: create an opaque agent post id. Keywords: collaboration, post, agent, id.
 * - createWorkbenchCollaborationPostId: create an opaque user post id. Keywords: collaboration, post, id.
 * - createWorkbenchCollaborationRevisionId: create an opaque revision id. Keywords: collaboration, revision, id.
 * - createWorkbenchCollaborationStateRelativePath: build the project-scoped disk state path. Keywords: collaboration, state, disk.
 * - ensureImportedScratchpadPost: add one imported scratchpad root post when content exists. Keywords: collaboration, scratchpad, import.
 * - mergeWorkbenchCollaborationState: merge local and persisted Collaboration state. Keywords: collaboration, state, merge.
 * - normalizeWorkbenchCollaborationPatchId: normalize collaborator-supplied post ids. Keywords: collaboration, patch, id.
 * - normalizeWorkbenchCollaborationState: normalize or migrate persisted Collaboration state. Keywords: collaboration, state, migration.
 * - normalizeWorkbenchCollaborationTag: normalize user-visible Collaboration tag labels. Keywords: collaboration, tag, label.
 * - normalizeWorkbenchCollaborationThreadRegistryFromState: temporary v1 registry projection. Keywords: collaboration, registry, compatibility.
 */

import type {
  WorkbenchCollaborationPost,
  WorkbenchCollaborationPostAuthor,
  WorkbenchCollaborationPostRevision,
  WorkbenchCollaborationPostRevisionSource,
  WorkbenchCollaborationState,
  WorkbenchCollaborationSuggestion,
  WorkbenchCollaborationThreadRegistry,
  WorkbenchThreadComposerAttachmentDraft,
} from "../../types";
import { areDeeplyEqual } from "../deep-equality";
import { encodeWorkbenchCollaborationProjectId } from "./collaboration-scratchpad-path";

export const WORKBENCH_COLLABORATION_STATE_VERSION = 2;
export const COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID = "imported-scratchpad";

export const EMPTY_WORKBENCH_COLLABORATION_STATE: WorkbenchCollaborationState = {
  autoWakeEnabled: false,
  lastAppliedPostPatchSignature: "",
  lastAppliedRunMemorySignature: "",
  lastAutoWakeAt: 0,
  lastRunMemory: "",
  posts: {},
  rootPostIds: [],
  runThreadIds: [],
  tags: [],
  version: WORKBENCH_COLLABORATION_STATE_VERSION,
};

const LEGACY_STARTED_SUGGESTIONS_KEY = "startedSuggestionThreads";

export function createWorkbenchCollaborationStateRelativePath(projectId: string) {
  return [
    ".workbench/collaboration/projects",
    encodeWorkbenchCollaborationProjectId(projectId),
    "registry.json",
  ].join("/");
}

export function normalizeWorkbenchCollaborationPatchId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function createWorkbenchCollaborationPostId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user:${crypto.randomUUID()}`;
  }

  return `user:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function createWorkbenchCollaborationAgentPostId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `agent:${crypto.randomUUID()}`;
  }

  return `agent:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function createWorkbenchCollaborationRevisionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `revision:${crypto.randomUUID()}`;
  }

  return `revision:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizeTrimmedText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBodyText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())))
    : [];
}

export function normalizeWorkbenchCollaborationTag(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeTagArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  const seenKeys = new Set<string>();
  for (const entry of value) {
    const tag = normalizeWorkbenchCollaborationTag(entry);
    const key = tag.toLocaleLowerCase();
    if (!tag || seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    tags.push(tag);
  }

  return tags;
}

function mergeUniqueTags(...tagLists: readonly string[][]) {
  const tags: string[] = [];
  const seenKeys = new Set<string>();
  for (const list of tagLists) {
    for (const tag of normalizeTagArray(list)) {
      const key = tag.toLocaleLowerCase();
      if (seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      tags.push(tag);
    }
  }

  return tags;
}

function normalizeAttachments(value: unknown): WorkbenchThreadComposerAttachmentDraft[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value.flatMap((entry): WorkbenchThreadComposerAttachmentDraft[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    const id = normalizeTrimmedText(candidate.id);
    const url = normalizeTrimmedText(candidate.url);
    return id && url ? [{ id, url }] : [];
  });

  return attachments.length ? attachments : undefined;
}

function normalizeRevisionSource(value: unknown): WorkbenchCollaborationPostRevisionSource {
  return value === "agent" || value === "restore" || value === "user" ? value : "user";
}

function normalizeAuthor(value: unknown): WorkbenchCollaborationPostAuthor {
  return value === "agent" ? "agent" : "user";
}

function normalizeRevision(value: unknown): WorkbenchCollaborationPostRevision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeTrimmedText(candidate.id);
  const body = normalizeBodyText(candidate.body);
  const createdAt = normalizeTimestamp(candidate.createdAt);
  if (!id || !createdAt) {
    return null;
  }

  const prompt = normalizeTrimmedText(candidate.prompt);
  const attachments = normalizeAttachments(candidate.attachments);
  return {
    body,
    createdAt,
    id,
    source: normalizeRevisionSource(candidate.source),
    ...(prompt ? { prompt } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

function normalizePost(value: unknown, fallbackId: string): WorkbenchCollaborationPost | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeWorkbenchCollaborationPatchId(normalizeTrimmedText(candidate.id) || fallbackId);
  if (!id) {
    return null;
  }

  const createdAt = normalizeTimestamp(candidate.createdAt) || Date.now();
  const updatedAt = normalizeTimestamp(candidate.updatedAt) || createdAt;
  const parentId = typeof candidate.parentId === "string"
    ? normalizeWorkbenchCollaborationPatchId(candidate.parentId) || null
    : null;
  const prompt = normalizeTrimmedText(candidate.prompt);
  const promptThreadId = normalizeTrimmedText(candidate.promptThreadId);
  const attachments = normalizeAttachments(candidate.attachments);
  const tags = normalizeTagArray(candidate.tags);
  const revisions = Array.isArray(candidate.revisions)
    ? candidate.revisions.flatMap((revision) => {
      const normalizedRevision = normalizeRevision(revision);
      return normalizedRevision ? [normalizedRevision] : [];
    })
    : [];

  return {
    author: normalizeAuthor(candidate.author),
    body: normalizeBodyText(candidate.body),
    childIds: normalizeStringArray(candidate.childIds).map(normalizeWorkbenchCollaborationPatchId).filter(Boolean),
    createdAt,
    id,
    ...(candidate.isCollapsed === true ? { isCollapsed: true } : {}),
    parentId,
    revisions,
    tags,
    updatedAt,
    ...(prompt ? { prompt } : {}),
    ...(promptThreadId ? { promptThreadId } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

function normalizePosts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const posts: Record<string, WorkbenchCollaborationPost> = {};
  for (const [rawId, rawPost] of Object.entries(value as Record<string, unknown>)) {
    const post = normalizePost(rawPost, rawId);
    if (post) {
      posts[post.id] = post;
    }
  }

  return posts;
}

function orderUniqueKnownPostIds(ids: readonly string[], posts: Record<string, WorkbenchCollaborationPost>) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const rawId of ids) {
    const id = normalizeWorkbenchCollaborationPatchId(rawId);
    if (!id || seen.has(id) || !posts[id]) {
      continue;
    }

    seen.add(id);
    ordered.push(id);
  }

  return ordered;
}

function normalizeTree(posts: Record<string, WorkbenchCollaborationPost>, rootPostIds: readonly string[]) {
  const nextPosts = Object.fromEntries(
    Object.entries(posts).map(([postId, post]) => [postId, { ...post, childIds: [] }]),
  ) as Record<string, WorkbenchCollaborationPost>;
  const rootIds = orderUniqueKnownPostIds(rootPostIds, nextPosts);
  const rootIdSet = new Set(rootIds);
  const referencedChildIds = new Set<string>();

  const appendChild = (parentId: string, childId: string) => {
    const parent = nextPosts[parentId];
    const child = nextPosts[childId];
    if (!parent || !child || childId === parentId || rootIdSet.has(childId) || referencedChildIds.has(childId)) {
      return;
    }

    referencedChildIds.add(childId);
    nextPosts[parent.id] = {
      ...parent,
      childIds: [...parent.childIds, childId],
    };
  };

  for (const parent of Object.values(posts)) {
    for (const rawChildId of parent.childIds) {
      const childId = normalizeWorkbenchCollaborationPatchId(rawChildId);
      if (nextPosts[childId]?.parentId === parent.id) {
        appendChild(parent.id, childId);
      }
    }
  }

  for (const post of Object.values(posts)) {
    const parent = post.parentId ? nextPosts[post.parentId] : null;
    if (parent) {
      appendChild(parent.id, post.id);
    }
  }

  for (const postId of Object.keys(nextPosts)) {
    if (!referencedChildIds.has(postId) && !rootIds.includes(postId)) {
      rootIds.push(postId);
    }
  }

  for (const rootId of rootIds) {
    const post = nextPosts[rootId];
    if (post?.parentId) {
      nextPosts[rootId] = {
        ...post,
        parentId: null,
      };
    }
  }

  return {
    posts: nextPosts,
    rootPostIds: rootIds,
  };
}

function normalizeSuggestion(value: unknown): WorkbenchCollaborationSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeWorkbenchCollaborationPatchId(normalizeTrimmedText(candidate.id));
  const prompt = normalizeTrimmedText(candidate.prompt);
  const title = normalizeTrimmedText(candidate.title);
  const updatedAt = normalizeTimestamp(candidate.updatedAt) || Date.now();
  if (!id || !prompt || !title) {
    return null;
  }

  const materializedThreadId = normalizeTrimmedText(candidate.materializedThreadId);
  const rationale = normalizeTrimmedText(candidate.rationale);
  return {
    id,
    prompt,
    title,
    updatedAt,
    ...(materializedThreadId ? { materializedThreadId } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

function normalizeLegacyStartedSuggestion(value: unknown): WorkbenchCollaborationSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeWorkbenchCollaborationPatchId(normalizeTrimmedText(candidate.suggestionId));
  const prompt = normalizeTrimmedText(candidate.prompt);
  const title = normalizeTrimmedText(candidate.title);
  const threadId = normalizeTrimmedText(candidate.threadId);
  const updatedAt = normalizeTimestamp(candidate.startedAt) || Date.now();
  if (!id || !prompt || !title || !threadId) {
    return null;
  }

  const rationale = normalizeTrimmedText(candidate.rationale);
  return {
    id,
    materializedThreadId: threadId,
    prompt,
    title,
    updatedAt,
    ...(rationale ? { rationale } : {}),
  };
}

function collectLegacySuggestions(candidate: Record<string, unknown>) {
  const suggestions = new Map<string, WorkbenchCollaborationSuggestion>();

  const rawSuggestions = candidate.suggestions;
  if (rawSuggestions && typeof rawSuggestions === "object" && !Array.isArray(rawSuggestions)) {
    for (const rawSuggestion of Object.values(rawSuggestions as Record<string, unknown>)) {
      const suggestion = normalizeSuggestion(rawSuggestion);
      if (suggestion) {
        suggestions.set(suggestion.id, suggestion);
      }
    }
  }

  const rawStartedSuggestions = candidate[LEGACY_STARTED_SUGGESTIONS_KEY];
  if (rawStartedSuggestions && typeof rawStartedSuggestions === "object" && !Array.isArray(rawStartedSuggestions)) {
    for (const rawStartedSuggestion of Object.values(rawStartedSuggestions as Record<string, unknown>)) {
      const suggestion = normalizeLegacyStartedSuggestion(rawStartedSuggestion);
      if (suggestion) {
        const existingSuggestion = suggestions.get(suggestion.id);
        suggestions.set(suggestion.id, {
          ...existingSuggestion,
          ...suggestion,
          updatedAt: Math.max(existingSuggestion?.updatedAt ?? 0, suggestion.updatedAt),
        });
      }
    }
  }

  return Array.from(suggestions.values());
}

function createPostFromLegacySuggestion(suggestion: WorkbenchCollaborationSuggestion): WorkbenchCollaborationPost {
  const body = suggestion.rationale
    ? `${suggestion.title}\n\n${suggestion.rationale}`
    : suggestion.title;
  return {
    author: "agent",
    body,
    childIds: [],
    createdAt: suggestion.updatedAt,
    id: suggestion.id,
    parentId: null,
    prompt: suggestion.prompt,
    revisions: [],
    tags: [],
    updatedAt: suggestion.updatedAt,
    ...(suggestion.materializedThreadId ? { promptThreadId: suggestion.materializedThreadId } : {}),
  };
}

function normalizeStateFromLegacyRegistry(value: unknown): WorkbenchCollaborationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_WORKBENCH_COLLABORATION_STATE;
  }

  const candidate = value as Record<string, unknown>;
  const suggestions = collectLegacySuggestions(candidate);
  const posts = Object.fromEntries(
    suggestions.map((suggestion) => [suggestion.id, createPostFromLegacySuggestion(suggestion)]),
  );
  const threadIds = normalizeStringArray(candidate.threadIds);
  const currentThreadId = normalizeTrimmedText(candidate.currentThreadId);
  const runThreadIds = currentThreadId
    ? Array.from(new Set([currentThreadId, ...threadIds]))
    : threadIds;

  return normalizeWorkbenchCollaborationState({
    autoWakeEnabled: candidate.autoWakeEnabled,
    lastAppliedPostPatchSignature: candidate.lastAppliedSuggestionPatchSignature,
    lastAppliedRunMemorySignature: candidate.lastAppliedRunMemorySignature,
    lastAutoWakeAt: candidate.lastAutoWakeAt,
    lastRunMemory: candidate.lastRunMemory ?? candidate.lastRunSummary,
    posts,
    rootPostIds: suggestions.map((suggestion) => suggestion.id),
    runThreadIds,
    tags: [],
    version: WORKBENCH_COLLABORATION_STATE_VERSION,
  });
}

export function normalizeWorkbenchCollaborationState(value: unknown): WorkbenchCollaborationState {
  if (typeof value === "string") {
    return {
      ...EMPTY_WORKBENCH_COLLABORATION_STATE,
      runThreadIds: value.trim() ? [value.trim()] : [],
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_WORKBENCH_COLLABORATION_STATE;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WORKBENCH_COLLABORATION_STATE_VERSION || !("posts" in candidate)) {
    return normalizeStateFromLegacyRegistry(candidate);
  }

  const posts = normalizePosts(candidate.posts);
  const tree = normalizeTree(posts, normalizeStringArray(candidate.rootPostIds));
  const postTags = Object.values(tree.posts).flatMap((post) => post.tags);
  return {
    autoWakeEnabled: candidate.autoWakeEnabled === true,
    lastAppliedPostPatchSignature: normalizeTrimmedText(candidate.lastAppliedPostPatchSignature),
    lastAppliedRunMemorySignature: normalizeTrimmedText(candidate.lastAppliedRunMemorySignature),
    lastAutoWakeAt: normalizeTimestamp(candidate.lastAutoWakeAt),
    lastRunMemory: normalizeTrimmedText(candidate.lastRunMemory) || normalizeTrimmedText(candidate.lastRunSummary),
    posts: tree.posts,
    rootPostIds: tree.rootPostIds,
    runThreadIds: normalizeStringArray(candidate.runThreadIds),
    tags: mergeUniqueTags(normalizeTagArray(candidate.tags), postTags),
    version: WORKBENCH_COLLABORATION_STATE_VERSION,
  };
}

export function ensureImportedScratchpadPost(
  state: WorkbenchCollaborationState,
  scratchpadMarkdown: string,
  now = Date.now(),
) {
  if (!scratchpadMarkdown.trim() || state.posts[COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID]) {
    return state;
  }

  const importedPost: WorkbenchCollaborationPost = {
    author: "user",
    body: `Imported scratchpad\n\n${scratchpadMarkdown}`,
    childIds: [],
    createdAt: now,
    id: COLLABORATION_IMPORTED_SCRATCHPAD_POST_ID,
    parentId: null,
    revisions: [],
    tags: [],
    updatedAt: now,
  };
  return normalizeWorkbenchCollaborationState({
    ...state,
    posts: {
      ...state.posts,
      [importedPost.id]: importedPost,
    },
    rootPostIds: [importedPost.id, ...state.rootPostIds],
  });
}

function mergeUniqueStrings(left: readonly string[], right: readonly string[]) {
  return Array.from(new Set([...left, ...right].filter((value) => Boolean(value.trim()))));
}

export function mergeWorkbenchCollaborationState(
  base: WorkbenchCollaborationState,
  incoming: WorkbenchCollaborationState,
): WorkbenchCollaborationState {
  const normalizedBase = normalizeWorkbenchCollaborationState(base);
  const normalizedIncoming = normalizeWorkbenchCollaborationState(incoming);
  const posts = { ...normalizedBase.posts };
  for (const [postId, incomingPost] of Object.entries(normalizedIncoming.posts)) {
    const existingPost = posts[postId];
    if (!existingPost || incomingPost.updatedAt >= existingPost.updatedAt || !areDeeplyEqual(existingPost, incomingPost)) {
      posts[postId] = !existingPost || incomingPost.updatedAt >= existingPost.updatedAt ? incomingPost : existingPost;
    }
  }

  return normalizeWorkbenchCollaborationState({
    autoWakeEnabled: normalizedIncoming.autoWakeEnabled,
    lastAppliedPostPatchSignature: normalizedIncoming.lastAppliedPostPatchSignature || normalizedBase.lastAppliedPostPatchSignature,
    lastAppliedRunMemorySignature: normalizedIncoming.lastAppliedRunMemorySignature || normalizedBase.lastAppliedRunMemorySignature,
    lastAutoWakeAt: Math.max(normalizedBase.lastAutoWakeAt, normalizedIncoming.lastAutoWakeAt),
    lastRunMemory: normalizedIncoming.lastRunMemory || normalizedBase.lastRunMemory,
    posts,
    rootPostIds: mergeUniqueStrings(normalizedIncoming.rootPostIds, normalizedBase.rootPostIds),
    runThreadIds: mergeUniqueStrings(normalizedIncoming.runThreadIds, normalizedBase.runThreadIds),
    tags: mergeUniqueTags(normalizedIncoming.tags, normalizedBase.tags),
    version: WORKBENCH_COLLABORATION_STATE_VERSION,
  });
}

export function normalizeWorkbenchCollaborationThreadRegistryFromState(
  state: WorkbenchCollaborationState,
): WorkbenchCollaborationThreadRegistry {
  const normalizedState = normalizeWorkbenchCollaborationState(state);
  const suggestions = Object.fromEntries(
    Object.values(normalizedState.posts)
      .filter((post) => post.prompt)
      .map((post) => [post.id, {
        id: post.id,
        ...(post.promptThreadId ? { materializedThreadId: post.promptThreadId } : {}),
        prompt: post.prompt ?? "",
        title: post.body.split(/\r?\n/)[0]?.trim() || "Collaboration prompt",
        updatedAt: post.updatedAt,
      } satisfies WorkbenchCollaborationSuggestion]),
  );

  return {
    autoWakeEnabled: normalizedState.autoWakeEnabled,
    currentThreadId: normalizedState.runThreadIds[0] ?? "",
    dismissedSuggestionIds: [],
    lastAppliedSuggestionPatchSignature: normalizedState.lastAppliedPostPatchSignature,
    lastAutoWakeAt: normalizedState.lastAutoWakeAt,
    lastRunSummary: normalizedState.lastRunMemory,
    suggestions,
    threadIds: normalizedState.runThreadIds,
  };
}
