/*
 * Exports:
 * - normalizeThreadTitle: trim and normalize candidate thread titles into a short UI-safe value.
 * - WORKBENCH_FILE_LINK_INSTRUCTIONS: shared injected guidance for agent-visible clickable file links. */
import { WORKBENCH_FILE_LINK_INSTRUCTIONS } from "./workbench/thread/workbench-file-link-instructions";

const MAX_THREAD_TITLE_LENGTH = 80;

export { WORKBENCH_FILE_LINK_INSTRUCTIONS };

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function normalizeThreadTitle(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeWhitespace(value)
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.]+$/g, "");

  if (!normalized) {
    return null;
  }

  return truncateText(normalized, MAX_THREAD_TITLE_LENGTH);
}


