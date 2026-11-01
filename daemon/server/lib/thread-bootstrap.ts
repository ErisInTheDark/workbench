/*
 * Exports:
 * - normalizeThreadTitle: trim and normalize candidate thread titles into a short UI-safe value.
 * - WORKBENCH_FILE_LINK_INSTRUCTIONS: shared injected guidance for agent-visible clickable file links.
 * - buildThreadTitleBootstrapInstructions: create managed-task CLI instructions for setting and reading its title through wb.
 */
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

export function buildThreadTitleBootstrapInstructions() {
  return `
## Workbench Task Title CLI

\`wb task set --title "<short title>" [--current-title "<exact current title>"]\`

\`wb task get\`

`.trimStart();
}

