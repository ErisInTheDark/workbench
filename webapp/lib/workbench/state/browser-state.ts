/**
 * Exports:
 * - DEFAULT_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE: editor font size defaults and bounds. Keywords: editor zoom, font size, clamp.
 * - EXPANDED_DIRECTORIES_STORAGE_KEY, FONT_SIZE_STORAGE_KEY, HARNESS_STORAGE_KEY, HARNESS_MODEL_STORAGE_KEY, HARNESS_MODEL_EFFORT_STORAGE_KEY, HARNESS_SERVICE_TIER_STORAGE_KEY, HARNESS_AGENT_STORAGE_KEY, THREAD_TOKEN_USAGE_STORAGE_KEY, THREAD_UNREAD_STATE_STORAGE_KEY, THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY, WORKBENCH_THEME_STORAGE_KEY: localStorage keys for persisted explorer, editor, harness, model, effort, service tier, agent, thread token usage, thread unread state, live activity disclosure state, and theme. Keywords: localStorage, explorer, font size, harness, model, effort, service tier, agent, threads, token usage, live activity, theme.
 * - readStoredExpandedDirectories: read and normalize persisted expanded directory paths for a project. Keywords: localStorage, explorer tree, expanded directories, browser state.
 * - persistExpandedDirectories: persist expanded directory paths for a project from a provided collection. Keywords: localStorage, explorer tree, persistence, directories.
 * - readStoredFontSize: read and clamp the persisted editor font size. Keywords: localStorage, editor zoom, font size, clamp.
 * - persistFontSize: persist a provided editor font size value. Keywords: localStorage, editor zoom, persistence.
 * - readStoredHarness/persistHarness: persist the selected bridge harness. Keywords: localStorage, codex, copilot, harness.
 * - readStoredHarnessModel/persistHarnessModel: persist the preferred model for each harness. Keywords: localStorage, codex, copilot, harness, model.
 * - readStoredHarnessModelEffort/persistHarnessModelEffort: persist the preferred reasoning effort for each harness/model pair. Keywords: localStorage, codex, copilot, harness, model, effort.
 * - readStoredHarnessServiceTier/persistHarnessServiceTier: persist the preferred service tier for each harness. Keywords: localStorage, codex, harness, service tier, fast.
 * - readStoredHarnessAgent/persistHarnessAgent: persist the preferred agent file for each harness. Keywords: localStorage, codex, copilot, harness, agent.
 * - readStoredThreadTokenUsage/persistThreadTokenUsage/clearStoredThreadTokenUsage: persist latest per-thread token usage when the harness only sends it as a live notification. Keywords: localStorage, thread, token usage, context.
 * - readStoredThreadUnreadState/persistThreadUnreadState: persist per-thread unread tracking for sidebar badges. Keywords: localStorage, threads, unread, badges.
 * - readStoredThreadLiveActivityOpen/persistThreadLiveActivityOpen: persist the shared thread live activity disclosure state. Keywords: localStorage, thread, reasoning, subagent, disclosure.
 * - readStoredWorkbenchTheme/persistWorkbenchTheme: persist the selected visual theme. Keywords: localStorage, theme, settings, appearance.
 * - readLocalWorkbenchOrigin: read the local loopback workbench origin for agent bootstrap URLs. Keywords: localhost, loopback, URL, workbench, bootstrap.
 */

import type { ThreadTokenUsage } from "../../codex/generated/app-server/v2/ThreadTokenUsage";
import type { TokenUsageBreakdown } from "../../codex/generated/app-server/v2/TokenUsageBreakdown";
import type { WorkbenchHarness, WorkbenchStoredThreadUnreadState } from "../../types";
import { normalizeWorkbenchAgentPath } from "../agent-paths";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  readStoredEditorFontSize,
  readStoredTheme,
  writeStoredEditorFontSize,
  writeStoredTheme,
  type WorkbenchTheme,
} from "./workbench-settings";

export { DEFAULT_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, type WorkbenchTheme };
export const EXPANDED_DIRECTORIES_STORAGE_KEY = "workbench:expanded-directories";
export const FONT_SIZE_STORAGE_KEY = "workbench:font-size";
export const HARNESS_STORAGE_KEY = "workbench:harness";
export const HARNESS_MODEL_STORAGE_KEY = "workbench:harness-models";
export const HARNESS_MODEL_EFFORT_STORAGE_KEY = "workbench:harness-model-efforts";
export const HARNESS_SERVICE_TIER_STORAGE_KEY = "workbench:harness-service-tiers";
export const HARNESS_AGENT_STORAGE_KEY = "workbench:harness-agents";
export const THREAD_TOKEN_USAGE_STORAGE_KEY = "workbench:thread-token-usage";
export const THREAD_UNREAD_STATE_STORAGE_KEY = "workbench:thread-unread-state";
export const THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY = "workbench:thread-live-activity-open";
export const WORKBENCH_THEME_STORAGE_KEY = "workbench:theme";

function normalizeStoredThreadUnreadState(value: unknown): WorkbenchStoredThreadUnreadState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<WorkbenchStoredThreadUnreadState>;
  if (
    typeof candidate.lastObservedStatus !== "string"
    || !Number.isFinite(candidate.lastObservedUpdatedAt)
    || !("lastSeenItemId" in candidate)
    || (candidate.lastSeenItemId !== null && typeof candidate.lastSeenItemId !== "string")
    || !Array.isArray(candidate.observedItemIds)
  ) {
    return null;
  }

  return {
    lastObservedStatus: candidate.lastObservedStatus,
    lastObservedUpdatedAt: Math.max(0, Math.trunc(candidate.lastObservedUpdatedAt)),
    lastSeenItemId: candidate.lastSeenItemId,
    observedItemIds: candidate.observedItemIds.filter((itemId): itemId is string => typeof itemId === "string"),
  };
}

function normalizeTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<TokenUsageBreakdown>;
  if (
    !Number.isFinite(candidate.totalTokens)
    || !Number.isFinite(candidate.inputTokens)
    || !Number.isFinite(candidate.cachedInputTokens)
    || !Number.isFinite(candidate.outputTokens)
    || !Number.isFinite(candidate.reasoningOutputTokens)
  ) {
    return null;
  }

  return {
    totalTokens: Math.max(0, Math.trunc(candidate.totalTokens)),
    inputTokens: Math.max(0, Math.trunc(candidate.inputTokens)),
    cachedInputTokens: Math.max(0, Math.trunc(candidate.cachedInputTokens)),
    outputTokens: Math.max(0, Math.trunc(candidate.outputTokens)),
    reasoningOutputTokens: Math.max(0, Math.trunc(candidate.reasoningOutputTokens)),
  };
}

function normalizeStoredThreadTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<ThreadTokenUsage>;
  const total = normalizeTokenUsageBreakdown(candidate.total);
  const last = normalizeTokenUsageBreakdown(candidate.last);
  if (
    !total
    || !last
    || !("modelContextWindow" in candidate)
    || (candidate.modelContextWindow !== null && !Number.isFinite(candidate.modelContextWindow))
  ) {
    return null;
  }

  return {
    total,
    last,
    modelContextWindow: candidate.modelContextWindow === null ? null : Math.max(0, Math.trunc(candidate.modelContextWindow)),
  };
}

function getThreadTokenUsageStateKey(harness: WorkbenchHarness, threadId: string) {
  return `${harness}:${threadId}`;
}

export function readStoredExpandedDirectories(projectId = "") {
  try {
    const storageKey = projectId ? `${EXPANDED_DIRECTORIES_STORAGE_KEY}:${projectId}` : EXPANDED_DIRECTORIES_STORAGE_KEY;
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return [""];
    }

    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) {
      return [""];
    }

    const normalizedPaths = parsedValue
      .filter((value): value is string => typeof value === "string")
      .sort((left, right) => left.localeCompare(right));

    return normalizedPaths.length > 0 ? normalizedPaths : [""];
  } catch {
    return [""];
  }
}

export function persistExpandedDirectories(expandedDirectories: Iterable<string>, projectId = "") {
  try {
    const storageKey = projectId ? `${EXPANDED_DIRECTORIES_STORAGE_KEY}:${projectId}` : EXPANDED_DIRECTORIES_STORAGE_KEY;
    const serialized = JSON.stringify(Array.from(expandedDirectories).sort((left, right) => left.localeCompare(right)));
    window.localStorage.setItem(storageKey, serialized);
  } catch {
    // Ignore storage failures and keep the in-memory explorer state working.
  }
}

export function readStoredFontSize() {
  return readStoredEditorFontSize();
}

export function persistFontSize(fontSize: number) {
  writeStoredEditorFontSize(fontSize);
}

export function readStoredHarness(): WorkbenchHarness {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_STORAGE_KEY);
    return rawValue === "copilot" ? "copilot" : "codex";
  } catch {
    return "codex";
  }
}

export function persistHarness(harness: WorkbenchHarness) {
  try {
    window.localStorage.setItem(HARNESS_STORAGE_KEY, harness);
  } catch {
    // Ignore storage failures and keep the in-memory harness state working.
  }
}

export function readStoredHarnessModel(harness: WorkbenchHarness) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedModel = parsedValue[harness];
    return typeof selectedModel === "string" && selectedModel.trim() ? selectedModel : null;
  } catch {
    return null;
  }
}

export function persistHarnessModel(harness: WorkbenchHarness, model: string) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, string>
      : {};

    nextValue[harness] = model;
    window.localStorage.setItem(HARNESS_MODEL_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory model state working.
  }
}

export function readStoredHarnessModelEffort(harness: WorkbenchHarness, model: string | null) {
  if (!model) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_EFFORT_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedHarness = parsedValue[harness];
    if (!selectedHarness || typeof selectedHarness !== "object" || Array.isArray(selectedHarness)) {
      return null;
    }

    const selectedEffort = selectedHarness[model];
    return typeof selectedEffort === "string" && selectedEffort.trim() ? selectedEffort : null;
  } catch {
    return null;
  }
}

export function persistHarnessModelEffort(harness: WorkbenchHarness, model: string, effort: string | null) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_EFFORT_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, Record<string, string | null>>
      : {};
    const nextHarnessValue = nextValue[harness] && typeof nextValue[harness] === "object" && !Array.isArray(nextValue[harness])
      ? nextValue[harness]
      : {};

    nextHarnessValue[model] = effort;
    nextValue[harness] = nextHarnessValue;
    window.localStorage.setItem(HARNESS_MODEL_EFFORT_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory effort state working.
  }
}

export function readStoredHarnessServiceTier(harness: WorkbenchHarness) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_SERVICE_TIER_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedTier = parsedValue[harness];
    return typeof selectedTier === "string" && selectedTier.trim() ? selectedTier : null;
  } catch {
    return null;
  }
}

export function persistHarnessServiceTier(harness: WorkbenchHarness, serviceTier: string | null) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_SERVICE_TIER_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, string | null>
      : {};

    nextValue[harness] = serviceTier;
    window.localStorage.setItem(HARNESS_SERVICE_TIER_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory service tier state working.
  }
}

export function readStoredHarnessAgent(harness: WorkbenchHarness) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_AGENT_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedAgent = parsedValue[harness];
    return normalizeWorkbenchAgentPath(typeof selectedAgent === "string" ? selectedAgent : null);
  } catch {
    return null;
  }
}

export function persistHarnessAgent(harness: WorkbenchHarness, agentPath: string | null) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_AGENT_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, string | null>
      : {};

    nextValue[harness] = normalizeWorkbenchAgentPath(agentPath);
    window.localStorage.setItem(HARNESS_AGENT_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory agent state working.
  }
}

export function readStoredThreadTokenUsage(harness: WorkbenchHarness, threadId: string) {
  try {
    const rawValue = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    return normalizeStoredThreadTokenUsage(parsedValue[getThreadTokenUsageStateKey(harness, threadId)]);
  } catch {
    return null;
  }
}

export function persistThreadTokenUsage(harness: WorkbenchHarness, threadId: string, tokenUsage: ThreadTokenUsage) {
  try {
    const rawValue = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, ThreadTokenUsage>
      : {};

    nextValue[getThreadTokenUsageStateKey(harness, threadId)] = tokenUsage;
    window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the live token usage state working.
  }
}

export function clearStoredThreadTokenUsage(harness: WorkbenchHarness, threadId: string) {
  try {
    const rawValue = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY);
    if (!rawValue) {
      return;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return;
    }

    delete (parsedValue as Record<string, ThreadTokenUsage>)[getThreadTokenUsageStateKey(harness, threadId)];
    window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(parsedValue));
  } catch {
    // Ignore storage failures and keep the live token usage state working.
  }
}

export function readStoredThreadUnreadState() {
  try {
    const rawValue = window.localStorage.getItem(THREAD_UNREAD_STATE_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsedValue).flatMap(([key, value]) => {
        const normalizedValue = normalizeStoredThreadUnreadState(value);
        return normalizedValue ? [[key, normalizedValue]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function persistThreadUnreadState(stateByKey: Record<string, WorkbenchStoredThreadUnreadState>) {
  try {
    window.localStorage.setItem(THREAD_UNREAD_STATE_STORAGE_KEY, JSON.stringify(stateByKey));
  } catch {
    // Ignore storage failures and keep the in-memory unread badge state working.
  }
}

export function readStoredThreadLiveActivityOpen() {
  try {
    return window.localStorage.getItem(THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function persistThreadLiveActivityOpen(isOpen: boolean) {
  try {
    window.localStorage.setItem(THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY, isOpen ? "true" : "false");
  } catch {
    // Ignore storage failures and keep the in-memory disclosure state working.
  }
}

export function readStoredWorkbenchTheme(): WorkbenchTheme {
  return readStoredTheme();
}

export function persistWorkbenchTheme(theme: WorkbenchTheme) {
  writeStoredTheme(theme);
}

export function readLocalWorkbenchOrigin() {
  const explicitOrigin = process.env.NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN?.trim();
  if (explicitOrigin) {
    return explicitOrigin.replace(/\/$/, "");
  }

  try {
    const currentUrl = new URL(window.location.href);
    const port = currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80");
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}
