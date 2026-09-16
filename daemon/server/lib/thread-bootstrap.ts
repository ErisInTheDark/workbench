/*
 * Exports:
 * - normalizeThreadTitle: trim and normalize candidate thread titles into a short UI-safe value.
 * - MODE_STATE_TAG_INSTRUCTIONS: shared injected guidance for agent-visible operating mode changes.
 * - WORKBENCH_FILE_LINK_INSTRUCTIONS: shared injected guidance for agent-visible clickable file links.
 * - buildThreadTitleBootstrapInstructions: create managed-task CLI instructions for setting and reading its title through wb.
 */
import { WORKBENCH_FILE_LINK_INSTRUCTIONS } from "./workbench/thread/workbench-file-link-instructions";

const MAX_THREAD_TITLE_LENGTH = 80;
export const MODE_STATE_TAG_INSTRUCTIONS = [
  "## Workbench Harness Display Contract:",
  "ALWAYS present plans and other findings as plain user-visible markdown-formatted chat text within <plan></plan> tags. Plans cannot be presented within questionnaire tool calls.",
  "NEVER present post-implementation reviews, retrospectives, or final messages in <plan></plan> tags.",
  "",
  "ALWAYS represent workflow-or-skill-provided mode changes with exactly one standalone tag line in this format: `<set-state mode=\"explore\" />`",
  'Example: "Switching to Inspect mode." should instead be `<set-state mode="Inspect" />` on its own line.',
  "Do not include additional user-facing text about the mode change unless EXPLICITLY required by the workflow.",
  "",
  "Most workflows that ask you to get approval for plans split them into two modes: a plan-presenting mode such as 'Brief mode', and a plan-approval mode such as 'Decision mode'.",
  "Make ABSOLUTELY SURE, as one of your most CRITICAL and PRIME DIRECTIVE rules, that you ALWAYS present the plan, THEN switch mode, THEN ask for approval.",
  "",
  "Example:",
  "<set-state mode=\"Brief\" />",
  "<plan>",
  "Current understanding:",
  "- ...",
  "- ...",
  "Concrete plan:",
  "- ...",
  "- ...",
  "Edges, risks, and validation strategy:",
  "- ...",
  "- ...",
  "</plan>",
  "",
  "<set-state mode=\"Decision\" />",
  "Do you approve this plan?",
  "[use request_user_input here]",
].join("\n");

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

