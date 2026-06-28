/*
 * Exports:
 * - WorkbenchCollaborationSuggestionPatch: JSON patch shape returned by Collaboration collaborator runs. Keywords: collaboration, suggestions, patch.
 * - parseWorkbenchCollaborationSuggestionPatch: read the hidden final collaborator JSON response. Keywords: collaboration, JSON, parse.
 * - applyWorkbenchCollaborationSuggestionPatch: merge collaborator suggestion patches into persisted Workbench state. Keywords: collaboration, suggestions, merge.
 * - findWorkbenchCollaborationSuggestionPatch: scan a thread payload for the latest suggestion patch. Keywords: collaboration, thread, final response.
 */

import type {
  ThreadPayload,
  WorkbenchCollaborationSuggestion,
} from "../../types";
import { areDeeplyEqual } from "../deep-equality";

export type WorkbenchCollaborationSuggestionPatch = Record<string, WorkbenchCollaborationSuggestionPatchEntry | null>;

export interface WorkbenchCollaborationSuggestionPatchEntry {
  prompt: string;
  rationale?: string;
  scratchpadImageIds?: string[];
  title: string;
}

export interface WorkbenchCollaborationSuggestionPatchResult {
  readonly signature: string;
  readonly suggestions: WorkbenchCollaborationSuggestionPatch;
  readonly summary: string;
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeSuggestionId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())))
    : [];
}

function createSuggestionPatchSignature(thread: ThreadPayload, turnIndex: number, itemIndex: number, text: string) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }

  return `${thread.id}:${turnIndex}:${itemIndex}:${(hash >>> 0).toString(36)}`;
}

function normalizePatchEntry(value: unknown): WorkbenchCollaborationSuggestionPatchEntry | null | undefined {
  if (value === null) {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const title = normalizeText(candidate.title);
  const prompt = normalizeText(candidate.prompt);
  const rationale = normalizeText(candidate.rationale);
  const scratchpadImageIds = normalizeStringArray(candidate.scratchpadImageIds);

  if (!title || !prompt) {
    return undefined;
  }

  return {
    prompt,
    title,
    ...(rationale ? { rationale } : {}),
    ...(scratchpadImageIds.length ? { scratchpadImageIds } : {}),
  };
}

export function parseWorkbenchCollaborationSuggestionPatch(value: string): WorkbenchCollaborationSuggestionPatchResult | null {
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
  const rawSuggestions = candidate.suggestions;
  if (!rawSuggestions || typeof rawSuggestions !== "object" || Array.isArray(rawSuggestions)) {
    return null;
  }

  const suggestions: WorkbenchCollaborationSuggestionPatch = {};
  for (const [rawId, rawEntry] of Object.entries(rawSuggestions as Record<string, unknown>)) {
    const id = normalizeSuggestionId(rawId);
    if (!id) {
      continue;
    }

    const entry = normalizePatchEntry(rawEntry);
    if (entry !== undefined) {
      suggestions[id] = entry;
    }
  }

  return {
    signature: "",
    suggestions,
    summary: normalizeText(candidate.summary),
  };
}

export function applyWorkbenchCollaborationSuggestionPatch(
  currentSuggestions: Record<string, WorkbenchCollaborationSuggestion>,
  patch: WorkbenchCollaborationSuggestionPatch,
  updatedAt: number,
) {
  let changed = false;
  const nextSuggestions = { ...currentSuggestions };

  for (const [id, entry] of Object.entries(patch)) {
    const existingSuggestion = nextSuggestions[id];
    if (entry === null) {
      if (id in nextSuggestions) {
        delete nextSuggestions[id];
        changed = true;
      }
      continue;
    }

    if (existingSuggestion?.materializedThreadId) {
      continue;
    }

    const nextSuggestion: WorkbenchCollaborationSuggestion = {
      id,
      prompt: entry.prompt,
      rationale: entry.rationale,
      scratchpadImageIds: entry.scratchpadImageIds,
      title: entry.title,
      updatedAt,
    };
    if (!areDeeplyEqual(existingSuggestion, nextSuggestion)) {
      nextSuggestions[id] = nextSuggestion;
      changed = true;
    }
  }

  return changed ? nextSuggestions : currentSuggestions;
}

export function findWorkbenchCollaborationSuggestionPatch(thread: ThreadPayload) {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (item.type !== "agentMessage") {
        continue;
      }

      const result = parseWorkbenchCollaborationSuggestionPatch(item.text);
      if (result) {
        return {
          ...result,
          signature: createSuggestionPatchSignature(thread, turnIndex, itemIndex, item.text),
        };
      }
    }
  }

  return null;
}
