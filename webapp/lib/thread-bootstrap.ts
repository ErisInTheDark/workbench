/*
 * Exports:
 * - DEFAULT_THREAD_TITLE_ROUTE_PATH: stable local HTTP endpoint path used for thread-title bootstrap calls. Keywords: thread title, route, workbench, bootstrap.
 * - normalizeThreadTitle: trim and normalize candidate thread titles into a short UI-safe value. Keywords: thread title, normalize, truncate.
 * - buildThreadTitleRouteUrl: compose the absolute thread-title route URL from a known workbench origin. Keywords: thread title, URL, origin.
 * - buildThreadTitleBootstrapInstructions: create the hidden PowerShell bootstrap instructions that tell a harness how to set a thread title through the local workbench route. Keywords: thread title, instructions, PowerShell, bootstrap.
 * - buildCodexThreadBootstrapInstructions: compose optional Codex agent-file guidance together with the shared title bootstrap instructions. Keywords: codex, agent, developer instructions, bootstrap.
 */
import type { WorkbenchHarness } from "./types";

const MAX_THREAD_TITLE_LENGTH = 80;
export const DEFAULT_THREAD_TITLE_ROUTE_PATH = "/api/thread-title";

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
    "Before your first substantive reply, if this thread does not already have a concise title, set one by running exactly one PowerShell call.",
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
  agentPath,
  harness,
  routeUrl,
  threadId,
}: {
  agentPath?: string | null;
  harness: WorkbenchHarness;
  routeUrl?: string | null;
  threadId: string;
}) {
  const sections: string[] = [];

  if (agentPath?.trim()) {
    sections.push(
      `For this thread, you are the agent defined in ${agentPath}. If you do not already have that file in your context window, read it before taking other actions. Treat it as CRITICAL rules to follow, only overridden by later user instructions.`,
    );
  }

  if (routeUrl?.trim()) {
    sections.push(buildThreadTitleBootstrapInstructions({
      harness,
      routeUrl,
      threadId,
    }));
  }

  return sections.length ? sections.join("\n\n") : null;
}
