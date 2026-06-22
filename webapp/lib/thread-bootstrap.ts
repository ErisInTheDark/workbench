/*
 * Exports:
 * - DEFAULT_THREAD_TITLE_ROUTE_PATH: stable local HTTP endpoint path used for thread-title bootstrap calls. Keywords: thread title, route, workbench, bootstrap.
 * - normalizeThreadTitle: trim and normalize candidate thread titles into a short UI-safe value. Keywords: thread title, normalize, truncate.
 * - buildThreadTitleRouteUrl: compose the absolute thread-title route URL from a known workbench origin. Keywords: thread title, URL, origin.
 * - MODE_STATE_TAG_INSTRUCTIONS: shared injected guidance for agent-visible operating mode changes. Keywords: mode, state tag, thread markdown.
 * - WORKBENCH_FILE_LINK_INSTRUCTIONS: shared injected guidance for agent-visible clickable file links. Keywords: thread markdown, file links, paths.
 * - buildThreadTitleBootstrapInstructions: create the hidden PowerShell bootstrap instructions that tell a harness how to set a thread title through the local workbench route. Keywords: thread title, instructions, PowerShell, bootstrap.
 * - buildCodexThreadBootstrapInstructions: compose optional Codex agent activation/definition content together with the shared title bootstrap instructions. Keywords: codex, agent, developer instructions, bootstrap.
 */
import type { WorkbenchAgentDefinition, WorkbenchHarness } from "./types";
import { WORKBENCH_FILE_LINK_INSTRUCTIONS } from "./workbench/thread/workbench-file-link-instructions";

const MAX_THREAD_TITLE_LENGTH = 80;
export const DEFAULT_THREAD_TITLE_ROUTE_PATH = "/api/thread-title";
export const MODE_STATE_TAG_INSTRUCTIONS = [
  "## Workbench Harness Display Contract:",
  "ALWAYS present plans and other findings as plain user-visible markdown-formatted chat text within <plan></plan> tags. Plans cannot be presented within questionnaire tool calls.",
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

function escapePowerShellSingleQuotedString(value: string) {
  return value.replace(/'/g, "''");
}

function buildAgentDefinitionInstructions(agentDefinition: WorkbenchAgentDefinition) {
  return [
    "For this thread, you are the agent defined below. Treat the contents of `<agent_definition>` as CRITICAL rules to follow, only overridden by later user instructions.",
    "<agent_definition>",
    `<name>${agentDefinition.name}</name>`,
    `<path>${agentDefinition.path}</path>`,
    agentDefinition.description ? `<description>${agentDefinition.description}</description>` : "",
    "<prompt>",
    agentDefinition.prompt.trim(),
    "</prompt>",
    "</agent_definition>",
  ].filter(Boolean).join("\n");
}

function buildDedupedAgentActivationInstructions(agentDefinition: WorkbenchAgentDefinition) {
  return [
    "For this thread, use the already-loaded Workbench agent named below as the active visible identity. Its full prompt body is already present in Codex global guidance and is intentionally not repeated here.",
    "<agent_activation>",
    `<name>${agentDefinition.name}</name>`,
    agentDefinition.description ? `<description>${agentDefinition.description}</description>` : "",
    "</agent_activation>",
  ].filter(Boolean).join("\n");
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

export function buildThreadTitleRouteUrl(origin: string) {
  const normalizedOrigin = origin.trim().replace(/\/$/, "");
  if (!normalizedOrigin) {
    return DEFAULT_THREAD_TITLE_ROUTE_PATH;
  }

  return `${normalizedOrigin}${DEFAULT_THREAD_TITLE_ROUTE_PATH}`;
}

export function buildThreadTitleBootstrapInstructions({
  harness,
  routeUrl,
  threadId,
}: {
  harness: WorkbenchHarness;
  routeUrl: string;
  threadId: string;
}) {
  const escapedHarness = escapePowerShellSingleQuotedString(harness);
  const escapedRouteUrl = escapePowerShellSingleQuotedString(routeUrl);
  const escapedThreadId = escapePowerShellSingleQuotedString(threadId);

  return [
    "CRITICAL: Before starting any work, if this thread does not already have a concise title, set one by running exactly one command.",
    "Use a short action-oriented title in plain ASCII words. Avoid quotes and apostrophes in the title text.",
    "",
    "$title = '<short action title>'",
    `$body = @{ harness = '${escapedHarness}'; threadId = '${escapedThreadId}'; title = $title } | ConvertTo-Json -Compress`,
    `Invoke-RestMethod -Method Post -Uri '${escapedRouteUrl}' -ContentType 'application/json' -Body $body | Out-Null`,
    "",
    "If the call fails once, continue normally.",
    "Do not mention the rename in chat.",
  ].join("\n");
}

export function buildCodexThreadBootstrapInstructions({
  agentDefinition,
  dedupedAgentDefinition,
  harness,
  routeUrl,
  threadId,
  workbenchLibraryInstructions,
}: {
  agentDefinition?: WorkbenchAgentDefinition | null;
  dedupedAgentDefinition?: WorkbenchAgentDefinition | null;
  harness: WorkbenchHarness;
  routeUrl?: string | null;
  threadId: string;
  workbenchLibraryInstructions?: string | null;
}) {
  const sections: string[] = [];

  if (workbenchLibraryInstructions?.trim()) {
    sections.push(workbenchLibraryInstructions);
  }

  if (agentDefinition?.prompt.trim()) {
    sections.push(buildAgentDefinitionInstructions(agentDefinition));
  } else if (dedupedAgentDefinition?.prompt.trim()) {
    sections.push(buildDedupedAgentActivationInstructions(dedupedAgentDefinition));
  }

  sections.push(MODE_STATE_TAG_INSTRUCTIONS);
  sections.push(WORKBENCH_FILE_LINK_INSTRUCTIONS);

  if (routeUrl?.trim()) {
    sections.push(buildThreadTitleBootstrapInstructions({
      harness,
      routeUrl,
      threadId,
    }));
  }

  return sections.length ? sections.join("\n\n") : null;
}
