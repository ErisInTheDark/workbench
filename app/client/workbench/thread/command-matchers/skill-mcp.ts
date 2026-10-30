/*
 * Exports:
 * - SkillMcpInvocation/readSkillMcpInvocation: the external MCP call a direct call or wb `mcp_call` makes, never a wb tool.
 * - readSkillMcpCallOutcome/readSkillMcpTextResult: an MCP call item's status, error and result as a matcher sees them;
 *   text answers that are JSON read as JSON.
 * - matchSkillMcpCall: ask the active skills' matchers about one call, once per runtime and call identity.
 * - getSkillMcpMatcherResult: turn a skill presentation into a command matcher result carrying its skill rendering.
 */
import type { JsonValue, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { WORKBENCH_MCP_SERVER_NAME } from "workbench-shared/workbench/mcp/mcp-server-settings";
import type { SkillMcpCall, SkillMcpPart } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import type { SkillMcpMatch, SkillMcpMatchers } from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import { CommandMatcher } from "./core";
import type { CommandMatcherResult, ThreadCommandDisplayPart } from "./types";

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

export type SkillMcpInvocation = Pick<SkillMcpCall, "arguments" | "keep" | "server" | "tool">;

function asRecord(value: JsonValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Workbench tools have their own presentation; skills present only calls to other servers. */
export function readSkillMcpInvocation(server: string, tool: string, argumentsValue: JsonValue, keep: string | null = null): SkillMcpInvocation | null {
  if (server !== WORKBENCH_MCP_SERVER_NAME && server !== "wbex") return { arguments: argumentsValue, keep, server, tool };
  if (tool !== "mcp_call") return null;
  const args = asRecord(argumentsValue);
  const target = args?.server;
  const targetTool = args?.tool;
  if (typeof target !== "string" || !target || target === WORKBENCH_MCP_SERVER_NAME || typeof targetTool !== "string" || !targetTool) return null;
  return { arguments: args?.arguments ?? {}, keep: typeof args?.keep === "string" && args.keep ? args.keep : null, server: target, tool: targetTool };
}

/** Text that is JSON reads as JSON, since most MCP servers answer that way. */
export function readSkillMcpTextResult(text: string): JsonValue {
  const trimmed = text.trim();
  if (!/^[[{]/u.test(trimmed)) return text;
  try { return JSON.parse(trimmed) as JsonValue; }
  catch { return text; }
}

export function readSkillMcpCallOutcome(item: Pick<McpToolCallItem, "error" | "result" | "status">): Pick<SkillMcpCall, "error" | "result" | "status"> {
  const status = item.status === "inProgress" ? "inProgress" : item.status === "completed" && !item.error ? "completed" : "failed";
  const structured = item.result?.structuredContent;
  const text = (item.result?.content ?? []).flatMap(part => {
    const record = asRecord(part);
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("\n");
  const result = structured !== undefined && structured !== null ? structured : text ? readSkillMcpTextResult(text) : null;
  return { error: item.error?.message ?? null, result, status };
}

const MAX_CACHED_INVOCATIONS = 2_000;
const matchesByRuntime = new WeakMap<SkillMcpMatchers, {
  byIdentity: WeakMap<object, SkillMcpMatch | null>;
  byInvocation: Map<string, SkillMcpMatch | null>;
}>();

/**
 * One answer per call: items are immutable, so an item (or arguments object) identifies its facts; invocation-only
 * calls (CLI text) key by their invocation.
 */
export function matchSkillMcpCall(runtime: SkillMcpMatchers, call: SkillMcpCall, identity?: object): SkillMcpMatch | null {
  let caches = matchesByRuntime.get(runtime);
  if (!caches) {
    caches = { byIdentity: new WeakMap(), byInvocation: new Map() };
    matchesByRuntime.set(runtime, caches);
  }
  if (identity) {
    if (caches.byIdentity.has(identity)) return caches.byIdentity.get(identity) ?? null;
    const match = runtime.match(call);
    caches.byIdentity.set(identity, match);
    return match;
  }
  const key = JSON.stringify(call);
  if (caches.byInvocation.has(key)) return caches.byInvocation.get(key) ?? null;
  const match = runtime.match(call);
  if (caches.byInvocation.size >= MAX_CACHED_INVOCATIONS) {
    const oldest = caches.byInvocation.keys().next().value;
    if (oldest !== undefined) caches.byInvocation.delete(oldest);
  }
  caches.byInvocation.set(key, match);
  return match;
}

function toDisplayPart(part: Exclude<SkillMcpPart, string>, skillPath: string): ThreadCommandDisplayPart {
  if ("code" in part) return CommandMatcher.Code(part.code);
  if ("primary" in part) return { text: part.primary, type: "text", variant: "primary" };
  if ("path" in part) return CommandMatcher.Path({ path: part.path });
  if ("component" in part) return { component: part.component, props: part.props ?? {}, skillPath, text: part.text, type: "skillComponent" };
  return CommandMatcher.Thread(part.thread);
}

/**
 * The verb, then each part. Rows space parts with a flex gap, so text carries its own edge spaces only for the line's
 * text form, as built-in matchers' `"Ran "` does; a separate space part would double the gap.
 */
function line(verb: string, parts: readonly SkillMcpPart[], skillPath: string) {
  const all = [verb, ...parts];
  return all.map((part, index): ThreadCommandDisplayPart => typeof part === "string"
    ? CommandMatcher.Text(`${index && typeof all[index - 1] !== "string" ? " " : ""}${part}${index < all.length - 1 ? " " : ""}`)
    : toDisplayPart(part, skillPath));
}

export function getSkillMcpMatcherResult(match: SkillMcpMatch, invocation: SkillMcpInvocation): CommandMatcherResult {
  const { presentation, skillName, skillPath } = match;
  return CommandMatcher.Result({
    omitFromDisplay: presentation.display === "hidden",
    ongoingSummaryParts: line(presentation.verb[0], presentation.summary, skillPath),
    remainingCommand: null,
    skillMcp: {
      call: invocation,
      chip: presentation.chip ? { icon: presentation.chip.icon, key: `${skillPath}\0${presentation.chip.id}`, verb: presentation.chip.verb } : null,
      component: presentation.component ?? null,
      display: presentation.display,
      icon: presentation.icon ?? presentation.chip?.icon ?? null,
      props: presentation.props ?? {},
      skillName,
      skillPath,
    },
    stop: true,
    summaryParts: line(presentation.verb[1], presentation.summary, skillPath),
  });
}
