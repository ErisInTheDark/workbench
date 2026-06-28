/*
 * Exports:
 * - EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY: canonical empty Collaboration registry state. Keywords: collaboration, registry, defaults.
 * - WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS: quiet-window delay before auto-running the collaborator. Keywords: collaboration, auto-wake, timer.
 * - createWorkbenchCollaborationRegistryRelativePath: build the project-scoped disk registry path. Keywords: collaboration, registry, disk.
 * - normalizeWorkbenchCollaborationThreadRegistry: normalize persisted/browser Collaboration registry data. Keywords: collaboration, registry, normalize.
 * - mergeWorkbenchCollaborationThreadRegistry: conservatively combine browser and disk Collaboration registry state. Keywords: collaboration, registry, merge.
 */

import type {
  WorkbenchCollaborationSuggestion,
  WorkbenchCollaborationThreadRegistry,
} from "../../types";
import { encodeWorkbenchCollaborationProjectId } from "./collaboration-scratchpad-path";

export const EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY: WorkbenchCollaborationThreadRegistry = {
  autoWakeEnabled: false,
  currentThreadId: "",
  dismissedSuggestionIds: [],
  lastAppliedSuggestionPatchSignature: "",
  lastAutoWakeAt: 0,
  lastRunSummary: "",
  suggestions: {},
  threadIds: [],
};
export const WORKBENCH_COLLABORATION_AUTO_WAKE_DELAY_MS = 2 * 60 * 1000;

export function createWorkbenchCollaborationRegistryRelativePath(projectId: string) {
  return [
    ".workbench/collaboration/projects",
    encodeWorkbenchCollaborationProjectId(projectId),
    "registry.json",
  ].join("/");
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeCollaborationSuggestion(value: unknown): WorkbenchCollaborationSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeText(candidate.id);
  const title = normalizeText(candidate.title);
  const prompt = normalizeText(candidate.prompt);
  const materializedThreadId = normalizeText(candidate.materializedThreadId);
  const rationale = normalizeText(candidate.rationale);
  const scratchpadImageIds = normalizeStringArray(candidate.scratchpadImageIds);
  const updatedAt = normalizeTimestamp(candidate.updatedAt) || Date.now();

  if (!id || !title || !prompt) {
    return null;
  }

  return {
    id,
    ...(materializedThreadId ? { materializedThreadId } : {}),
    prompt,
    title,
    updatedAt,
    ...(rationale ? { rationale } : {}),
    ...(scratchpadImageIds.length ? { scratchpadImageIds } : {}),
  };
}

function normalizeCollaborationSuggestions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const suggestions: Record<string, WorkbenchCollaborationSuggestion> = {};
  for (const [key, rawSuggestion] of Object.entries(value as Record<string, unknown>)) {
    const suggestion = normalizeCollaborationSuggestion(rawSuggestion);
    if (!suggestion) {
      continue;
    }

    suggestions[suggestion.id || key] = suggestion;
  }

  return suggestions;
}

function normalizeLegacyStartedSuggestion(value: unknown): WorkbenchCollaborationSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const suggestionId = normalizeText(candidate.suggestionId);
  const threadId = normalizeText(candidate.threadId);
  const title = normalizeText(candidate.title);
  const prompt = normalizeText(candidate.prompt);
  const rationale = normalizeText(candidate.rationale);
  const scratchpadImageIds = normalizeStringArray(candidate.scratchpadImageIds);
  const startedAt = normalizeTimestamp(candidate.startedAt) || Date.now();

  if (!suggestionId || !threadId || !title || !prompt) {
    return null;
  }

  return {
    id: suggestionId,
    materializedThreadId: threadId,
    prompt,
    title,
    updatedAt: startedAt,
    ...(rationale ? { rationale } : {}),
    ...(scratchpadImageIds.length ? { scratchpadImageIds } : {}),
  };
}

function normalizeLegacyStartedSuggestions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const suggestions: Record<string, WorkbenchCollaborationSuggestion> = {};
  for (const [key, rawStartedSuggestion] of Object.entries(value as Record<string, unknown>)) {
    const suggestion = normalizeLegacyStartedSuggestion(rawStartedSuggestion);
    if (!suggestion) {
      continue;
    }

    suggestions[suggestion.id || key] = suggestion;
  }

  return suggestions;
}

function mergeLegacyMaterializedSuggestions(
  suggestions: Record<string, WorkbenchCollaborationSuggestion>,
  legacySuggestions: Record<string, WorkbenchCollaborationSuggestion>,
) {
  const merged = { ...suggestions };
  for (const [suggestionId, legacySuggestion] of Object.entries(legacySuggestions)) {
    const existingSuggestion = merged[suggestionId];
    if (!existingSuggestion) {
      merged[suggestionId] = legacySuggestion;
      continue;
    }

    if (!existingSuggestion.materializedThreadId || legacySuggestion.updatedAt >= existingSuggestion.updatedAt) {
      merged[suggestionId] = {
        ...legacySuggestion,
        ...existingSuggestion,
        materializedThreadId: legacySuggestion.materializedThreadId,
        updatedAt: Math.max(existingSuggestion.updatedAt, legacySuggestion.updatedAt),
      };
    }
  }

  return merged;
}

export function normalizeWorkbenchCollaborationThreadRegistry(value: unknown): WorkbenchCollaborationThreadRegistry {
  if (typeof value === "string") {
    return {
      ...EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY,
      currentThreadId: value,
      threadIds: value ? [value] : [],
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_WORKBENCH_COLLABORATION_THREAD_REGISTRY;
  }

  const candidate = value as Record<string, unknown>;
  const threadIds = normalizeStringArray(candidate.threadIds);
  const currentThreadId = typeof candidate.currentThreadId === "string" && threadIds.includes(candidate.currentThreadId)
    ? candidate.currentThreadId
    : threadIds[0] ?? "";
  const legacyMaterializedSuggestions = normalizeLegacyStartedSuggestions(candidate.startedSuggestionThreads);
  const legacyMaterializedSuggestionIds = new Set(Object.keys(legacyMaterializedSuggestions));
  const dismissedSuggestionIds = normalizeStringArray(candidate.dismissedSuggestionIds)
    .filter((suggestionId) => !legacyMaterializedSuggestionIds.has(suggestionId));
  const dismissedSuggestionIdSet = new Set(dismissedSuggestionIds);
  const mergedSuggestions = mergeLegacyMaterializedSuggestions(
    normalizeCollaborationSuggestions(candidate.suggestions),
    legacyMaterializedSuggestions,
  );
  const suggestions = Object.fromEntries(
    Object.entries(mergedSuggestions)
      .filter(([suggestionId]) => !dismissedSuggestionIdSet.has(suggestionId)),
  );

  return {
    autoWakeEnabled: candidate.autoWakeEnabled === true,
    currentThreadId,
    dismissedSuggestionIds,
    lastAppliedSuggestionPatchSignature: normalizeText(candidate.lastAppliedSuggestionPatchSignature),
    lastAutoWakeAt: normalizeTimestamp(candidate.lastAutoWakeAt),
    lastRunSummary: normalizeText(candidate.lastRunSummary),
    suggestions,
    threadIds,
  };
}

function mergeUniqueStrings(left: readonly string[], right: readonly string[]) {
  return Array.from(new Set([...left, ...right].filter((value) => Boolean(value.trim()))));
}

function mergeSuggestions(
  left: Record<string, WorkbenchCollaborationSuggestion>,
  right: Record<string, WorkbenchCollaborationSuggestion>,
  dismissedSuggestionIds: Set<string>,
) {
  const merged = { ...left };
  for (const [suggestionId, incomingSuggestion] of Object.entries(right)) {
    if (dismissedSuggestionIds.has(suggestionId)) {
      delete merged[suggestionId];
      continue;
    }

    const existingSuggestion = merged[suggestionId];
    if (!existingSuggestion || incomingSuggestion.updatedAt >= existingSuggestion.updatedAt) {
      merged[suggestionId] = incomingSuggestion;
    }
  }

  for (const suggestionId of dismissedSuggestionIds) {
    delete merged[suggestionId];
  }
  return merged;
}

export function mergeWorkbenchCollaborationThreadRegistry(
  base: WorkbenchCollaborationThreadRegistry,
  incoming: WorkbenchCollaborationThreadRegistry,
): WorkbenchCollaborationThreadRegistry {
  const dismissedSuggestionIds = mergeUniqueStrings(base.dismissedSuggestionIds, incoming.dismissedSuggestionIds);
  const dismissedSuggestionIdSet = new Set(dismissedSuggestionIds);
  const threadIds = mergeUniqueStrings(incoming.threadIds, base.threadIds);
  const currentThreadId = incoming.currentThreadId && threadIds.includes(incoming.currentThreadId)
    ? incoming.currentThreadId
    : base.currentThreadId && threadIds.includes(base.currentThreadId)
      ? base.currentThreadId
      : threadIds[0] ?? "";

  return {
    autoWakeEnabled: incoming.autoWakeEnabled,
    currentThreadId,
    dismissedSuggestionIds,
    lastAppliedSuggestionPatchSignature: incoming.lastAppliedSuggestionPatchSignature || base.lastAppliedSuggestionPatchSignature,
    lastAutoWakeAt: Math.max(base.lastAutoWakeAt, incoming.lastAutoWakeAt),
    lastRunSummary: incoming.lastRunSummary || base.lastRunSummary,
    suggestions: mergeSuggestions(base.suggestions, incoming.suggestions, dismissedSuggestionIdSet),
    threadIds,
  };
}
