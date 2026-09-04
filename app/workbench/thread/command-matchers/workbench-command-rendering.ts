/*
 * Exports:
 * - WorkbenchCommandPresentationName/WORKBENCH_COMMAND_PRESENTATION_NAMES: canonical wb tool inventory shared by CLI and MCP adapters. Keywords: workbench, command, inventory, toc.
 * - WorkbenchCommandRoute/WorkbenchSpecializedOperation/WorkbenchCommandPresentationContext: route one wb operation with optional path context to a dedicated or simple renderer. Keywords: workbench, command, route, renderer, toc.
 * - getWorkbenchCommandRoute/getWorkbenchCommandRendering/getWorkbenchCommandSummaryDisplay/getWorkbenchCommandRouteSummaryDisplay: resolve structured arguments and routes into shared rendering metadata. Keywords: workbench, CLI, MCP, rendering, toc.
 */
import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";

import type { GitArcMoveArguments } from "workbench-shared/workbench/git/git-arc-move-arguments";
import { CommandMatcher } from "./core";
import {
  createEmptyCommandSummaryStats,
  summarizeDisplayParts,
} from "./helpers";
import { tokenizeCommand } from "./helpers";
import RipgrepCommand from "./ripgrep";
import type {
  CommandMatcherResult,
  ThreadCommandDetailRow,
  ThreadCommandDisplayPart,
  ThreadCommandSummaryDisplay,
  ThreadCommandSummaryStats,
} from "./types";

export const WORKBENCH_COMMAND_PRESENTATION_NAMES = [
  "toc",
  "rg",
  "tokens",
  "tokens_instructions",
  "tokens_project",
  "subagent_list",
  "subagent_profiles",
  "subagent_create",
  "subagent_wait",
  "subagent_stop",
  "subagent_settle",
  "subagent_message",
  "thread_title_get",
  "thread_title",
  "thread_status",
  "thread_refresh",
  "thread_recall_search",
  "thread_recall_expand",
  "thread_recall",
  "git_add",
  "git_unstage",
  "git_commit",
  "git_arc_plan",
  "git_arc_plan_add",
  "git_arc_plan_remove",
  "git_arc_plan_adopt",
  "git_arc_plan_start",
  "git_arc_start",
  "git_arc_wait",
  "git_arc_continue",
  "git_arc_add",
  "git_arc_adopt",
  "git_arc_mv",
  "git_arc_remove",
  "git_arc_release",
  "git_arc_compare",
  "git_arc_diff",
  "git_arc_propose",
  "git_arc_rescind",
  "git_arc_restore",
  "browse_run",
  "browse_raw",
  "browse_sessions",
  "browse_stop",
  "browse_forget",
] as const;

export type WorkbenchCommandPresentationName = typeof WORKBENCH_COMMAND_PRESENTATION_NAMES[number];

export type WorkbenchGitArcOperation = {
  action: "add" | "adopt" | "compare" | "continue" | "diff" | "mv" | "plan" | "planAdd" | "planAdopt" | "planRemove" | "planStart" | "propose" | "release" | "remove" | "rescind" | "restore" | "start";
  adoptPaths?: string[];
  disown?: boolean;
  intentName: string | null;
  move?: GitArcMoveArguments;
  paths: string[];
  proposalId?: string | null;
  proposalIntent?: {
    amend: boolean;
    description: string;
    freshDescription?: string;
    freshTitle?: string;
    paths: string[];
    rootId?: string;
    title: string;
  } | null;
  ref: string | null;
};

export interface WorkbenchSubagentOperation {
  action: "create" | "message" | "settle" | "stop" | "wait";
  message: string | null;
  name: string | null;
  profileId: string | null;
  targets: Array<{ kind: "id" | "name"; value: string }>;
  title: string | null;
  toParent: boolean;
}

export type WorkbenchSpecializedOperation =
  | { kind: "gitArc"; operation: WorkbenchGitArcOperation }
  | { kind: "gitArcWait"; ref: string | null }
  | { kind: "subagent"; operation: WorkbenchSubagentOperation }
  | { kind: "threadRecall" }
  | { kind: "threadStatus"; status: "blocked" | "completed" }
  | { kind: "threadTitle"; title: string };

export interface WorkbenchCommandRendering {
  claimedBy: string;
  result: CommandMatcherResult;
}

export type WorkbenchCommandPresentationContext = RipgrepCommand.PresentationContext;

export type WorkbenchCommandRoute =
  | { kind: "simple"; rendering: WorkbenchCommandRendering }
  | { kind: "specialized"; operation: WorkbenchSpecializedOperation; rendering: WorkbenchCommandRendering };

const PRESENTATION_NAME_SET = new Set<string>(WORKBENCH_COMMAND_PRESENTATION_NAMES);

export function isWorkbenchCommandPresentationName(value: string): value is WorkbenchCommandPresentationName {
  return PRESENTATION_NAME_SET.has(value);
}

function asRecord(value: JsonValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readString(value: JsonValue | undefined) {
  return typeof value === "string" ? value : null;
}

function readBoolean(value: JsonValue | undefined) {
  return typeof value === "boolean" ? value : false;
}

function readStringArray(value: JsonValue | undefined) {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value
    : [];
}

function readRootPaths(value: JsonValue | undefined, field: "adoptPaths" | "paths") {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const entry = asRecord(candidate);
    const rootId = readString(entry?.rootId);
    if (!rootId) return [];
    return readStringArray(entry?.[field]).map((filePath) => `${rootId}:${filePath}`);
  });
}

function rendering({
  claimedBy,
  detailRows,
  hideCommandCwd = false,
  hideCommandOutput = false,
  ongoing,
  stats,
  summary,
}: {
  claimedBy: string;
  detailRows?: ThreadCommandDetailRow[];
  hideCommandCwd?: boolean;
  hideCommandOutput?: boolean;
  ongoing: string | ThreadCommandDisplayPart[];
  stats?: Partial<ThreadCommandSummaryStats>;
  summary: string | ThreadCommandDisplayPart[];
}): WorkbenchCommandRendering {
  return {
    claimedBy,
    result: CommandMatcher.Result({
      detailRows,
      hideCommandCwd,
      hideCommandOutput,
      ongoingSummaryParts: typeof ongoing === "string" ? [CommandMatcher.Text(ongoing)] : ongoing,
      remainingCommand: null,
      stop: true,
      summaryParts: typeof summary === "string" ? [CommandMatcher.Text(summary)] : summary,
      summaryStats: stats,
    }),
  };
}

function simple(
  claimedBy: string,
  ongoing: string | ThreadCommandDisplayPart[],
  summary: string | ThreadCommandDisplayPart[],
  stats?: Partial<ThreadCommandSummaryStats>,
) {
  return { kind: "simple", rendering: rendering({ claimedBy, ongoing, stats, summary }) } satisfies WorkbenchCommandRoute;
}

function specialized(
  claimedBy: string,
  operation: WorkbenchSpecializedOperation,
  stats?: Partial<ThreadCommandSummaryStats>,
) {
  return {
    kind: "specialized",
    operation,
    rendering: {
      claimedBy,
      result: CommandMatcher.Result({
        omitFromDisplay: true,
        ongoingSummaryParts: [],
        remainingCommand: null,
        stop: true,
        summaryParts: [],
        summaryStats: stats,
      }),
    },
  } satisfies WorkbenchCommandRoute;
}

function pluralize(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}

function primary(text: string): ThreadCommandDisplayPart {
  return { text, type: "text", variant: "primary" };
}

function actionTarget(action: string, target: string): ThreadCommandDisplayPart[] {
  return [CommandMatcher.Text(action), primary(target)];
}

function formatBrowseActionLabel(action: string) {
  const labels: Record<string, string> = {
    cleanup: "Clean up",
    click: "Click",
    doctor: "Diagnostics",
    eval: "Evaluate",
    fill: "Fill",
    forget: "Forget persistent profile",
    get: "Read",
    highlight: "Highlight",
    is: "Check",
    key: "Press key",
    open: "Open",
    refs: "Refs",
    reload: "Reload",
    screenshot: "Screenshot",
    select: "Select",
    snapshot: "Snapshot",
    status: "Status",
    stop: "Stop",
    type: "Type",
    viewport: "Viewport",
    wait: "Wait",
  };
  return labels[action] ?? action.replace(/[-_]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
}

function buildBrowseDetailRow(command: string, index: number): ThreadCommandDetailRow {
  const tokens = tokenizeCommand(command) ?? [command];
  const action = tokens[0] ?? "command";
  const args = tokens.slice(1);
  const targetText = ["open", "click", "fill", "get", "is", "highlight", "select", "eval", "wait"].includes(action)
    ? args.filter((value) => !value.startsWith("--"))[0] ?? null
    : ["mouse", "move"].includes(action) ? args.join(" ") || null : null;
  const label = formatBrowseActionLabel(action);
  return {
    id: `browse-command-${index}`,
    label,
    summaryParts: [CommandMatcher.Text(label)],
    ...(targetText
      ? { target: { kind: /^https?:\/\//iu.test(targetText) ? "url" as const : "code" as const, text: targetText } }
      : {}),
  };
}

function appendBrowseSession(parts: ThreadCommandDisplayPart[], session: string | null) {
  if (session) parts.push(CommandMatcher.Text(" in "), CommandMatcher.Code(session));
}

function renderBrowse(name: WorkbenchCommandPresentationName, args: { [key: string]: JsonValue | undefined }): WorkbenchCommandRoute {
  const session = readString(args.session);
  if (name === "browse_run") {
    const commands = readStringArray(args.commands);
    const scriptPath = readString(args.scriptPath);
    const requestedSummary = readString(args.summary);
    const summaryParts: ThreadCommandDisplayPart[] = requestedSummary
      ? [CommandMatcher.Text("Browse: "), primary(requestedSummary)]
      : scriptPath
        ? [CommandMatcher.Text("Browse: run script "), CommandMatcher.Code(scriptPath)]
        : actionTarget("Browse: run ", `${commands.length} ${pluralize(commands.length, "action")}`);
    const ongoingParts: ThreadCommandDisplayPart[] = requestedSummary
      ? [CommandMatcher.Text("Browsing: "), primary(requestedSummary)]
      : scriptPath
        ? [CommandMatcher.Text("Browsing: running script "), CommandMatcher.Code(scriptPath)]
        : actionTarget("Browsing: running ", `${commands.length} ${pluralize(commands.length, "action")}`);
    appendBrowseSession(summaryParts, session);
    appendBrowseSession(ongoingParts, session);
    return {
      kind: "simple",
      rendering: rendering({
        claimedBy: "browse.command",
        detailRows: commands.map(buildBrowseDetailRow),
        hideCommandCwd: true,
        hideCommandOutput: true,
        ongoing: ongoingParts,
        stats: { webRequests: 1 },
        summary: summaryParts,
      }),
    };
  }
  if (name === "browse_raw") {
    const rawAction = readString(args.rawAction) ?? "raw";
    const actionLabel = formatBrowseActionLabel(rawAction).toLowerCase();
    const summaryParts = actionTarget("Browse: ", actionLabel);
    const ongoingParts = actionTarget("Browsing: running ", actionLabel);
    appendBrowseSession(summaryParts, session);
    appendBrowseSession(ongoingParts, session);
    return {
      kind: "simple",
      rendering: rendering({ claimedBy: "browse.command", hideCommandCwd: true, hideCommandOutput: true, ongoing: ongoingParts, stats: { webRequests: 1 }, summary: summaryParts }),
    };
  }
  const action = name.slice("browse_".length);
  const label = action === "sessions" ? "list sessions" : action === "stop" ? "stop session" : "forget persistent profile";
  const ongoingLabel = action === "sessions" ? "listing sessions" : action === "stop" ? "stopping session" : "forgetting persistent profile";
  const summaryParts = actionTarget("Browse: ", label);
  const ongoingParts = actionTarget("Browsing: ", ongoingLabel);
  appendBrowseSession(summaryParts, session);
  appendBrowseSession(ongoingParts, session);
  return {
    kind: "simple",
    rendering: rendering({ claimedBy: "browse.command", hideCommandCwd: true, hideCommandOutput: true, ongoing: ongoingParts, stats: { webRequests: 1 }, summary: summaryParts }),
  };
}

function gitArcAction(name: WorkbenchCommandPresentationName): WorkbenchGitArcOperation["action"] | null {
  const actions: Partial<Record<WorkbenchCommandPresentationName, WorkbenchGitArcOperation["action"]>> = {
    git_arc_add: "add",
    git_arc_adopt: "adopt",
    git_arc_compare: "compare",
    git_arc_continue: "continue",
    git_arc_diff: "diff",
    git_arc_mv: "mv",
    git_arc_plan: "plan",
    git_arc_plan_add: "planAdd",
    git_arc_plan_adopt: "planAdopt",
    git_arc_plan_remove: "planRemove",
    git_arc_plan_start: "planStart",
    git_arc_propose: "propose",
    git_arc_release: "release",
    git_arc_remove: "remove",
    git_arc_rescind: "rescind",
    git_arc_restore: "restore",
    git_arc_start: "start",
  };
  return actions[name] ?? null;
}

function renderGitArc(name: WorkbenchCommandPresentationName, args: { [key: string]: JsonValue | undefined }) {
  const action = gitArcAction(name);
  if (!action) return null;
  const move = asRecord(args.move);
  const moveKind = readString(move?.kind);
  const parsedMove: GitArcMoveArguments | undefined = moveKind === "operands"
    ? { kind: "operands", operands: readStringArray(move?.operands) }
    : moveKind === "maps" && Array.isArray(move?.mappings)
      ? {
        kind: "maps",
        mappings: move.mappings.flatMap((entry) => {
          const mapping = asRecord(entry);
          const source = readString(mapping?.source);
          const destination = readString(mapping?.destination);
          return source && destination ? [{ destination, source }] : [];
        }),
      }
      : moveKind === "regex"
        ? {
          confirm: readBoolean(move?.confirm),
          kind: "regex",
          pattern: readString(move?.pattern) ?? "",
          replacement: readString(move?.replacement) ?? "",
          roots: readStringArray(move?.roots),
        }
        : undefined;
  const messages = [readString(args.title), readString(args.description)].filter((value): value is string => value !== null);
  const paths = [...readStringArray(args.paths), ...readRootPaths(args.roots, "paths")];
  const adoptPaths = [...readStringArray(args.adoptPaths), ...readRootPaths(args.roots, "adoptPaths")];
  const intentName = readString(args.intentName);
  const freshDescription = readString(args.freshDescription);
  const freshTitle = readString(args.freshTitle);
  const proposalId = readString(args.proposalId) ?? readString(args.amendProposalId) ?? readString(args.replaceProposalId);
  const operation: WorkbenchGitArcOperation = {
    action,
    ...(adoptPaths.length ? { adoptPaths } : {}),
    ...(action === "release" ? { disown: readBoolean(args.disown) } : {}),
    intentName,
    ...(parsedMove ? { move: parsedMove } : {}),
    paths,
    ...(proposalId ? { proposalId } : {}),
    ...(action === "propose"
      ? {
        proposalIntent: {
          amend: readBoolean(args.amend),
          description: messages[1] ?? readString(args.description) ?? "",
          ...(freshDescription !== null ? { freshDescription } : {}),
          ...(freshTitle ? { freshTitle } : {}),
          paths,
          ...(readString(args.rootId) ? { rootId: readString(args.rootId)! } : {}),
          title: messages[0] ?? "",
        },
      }
      : {}),
    ref: readString(args.ref),
  };
  const matcherIds: Record<WorkbenchGitArcOperation["action"], string> = {
    add: "git-arc.add",
    adopt: "git-arc.adopt",
    compare: "git-arc.compare",
    continue: "git-arc.continue",
    diff: "git-arc.diff",
    mv: "git-arc.mv",
    plan: "git-arc.plan",
    planAdd: "git-arc.plan-add",
    planAdopt: "git-arc.plan-adopt",
    planRemove: "git-arc.plan-remove",
    planStart: "git-arc.plan-start",
    propose: "git-arc.propose",
    release: "git-arc.release",
    remove: "git-arc.remove",
    rescind: "git-arc.rescind",
    restore: "git-arc.restore",
    start: "git-arc.start",
  };
  const stats = action === "compare" || action === "diff" || action === "start"
    ? { gitCheckpointDiffs: 1 }
    : action === "restore"
      ? { gitCheckpointRestores: 1 }
      : action === "propose" || action === "rescind" ? undefined : { gitCheckpointCreates: 1 };
  return specialized(matcherIds[action], { kind: "gitArc", operation }, stats);
}

function renderSubagent(name: WorkbenchCommandPresentationName, args: { [key: string]: JsonValue | undefined }): WorkbenchCommandRoute {
  const action = name.slice("subagent_".length) as "create" | "list" | "message" | "profiles" | "settle" | "stop" | "wait";
  const names = readStringArray(args.names);
  const threadIds = readStringArray(args.threadIds);
  const singleName = readString(args.name);
  const singleThreadId = readString(args.threadId);
  const targets = [
    ...names.map((value) => ({ kind: "name" as const, value })),
    ...threadIds.map((value) => ({ kind: "id" as const, value })),
    ...(singleName ? [{ kind: "name" as const, value: singleName }] : []),
    ...(singleThreadId ? [{ kind: "id" as const, value: singleThreadId }] : []),
  ];
  const toParent = readBoolean(args.parent);
  if (
    action === "create"
    || action === "wait"
    || action === "stop"
    || action === "settle"
    || (action === "message" && (targets.length || toParent))
  ) {
    return specialized("workbench-cli.subagent", {
      kind: "subagent",
      operation: {
        action,
        message: readString(args.message),
        name: action === "create" ? singleName : null,
        profileId: readString(args.profileId),
        targets,
        title: readString(args.title),
        toParent,
      },
    });
  }
  const target = action === "list" ? "subagents"
    : action === "message" ? "subagent"
      : "subagent profiles";
  return simple(
    "workbench-cli.subagent",
    actionTarget(action === "message" ? "Messaging " : "Listing ", target),
    actionTarget(action === "message" ? "Messaged " : "Listed ", target),
  );
}

export function getWorkbenchCommandRoute(
  name: WorkbenchCommandPresentationName,
  argumentsValue: JsonValue,
  context: WorkbenchCommandPresentationContext = {},
): WorkbenchCommandRoute | null {
  const args = asRecord(argumentsValue) ?? {};
  const gitArc = renderGitArc(name, args);
  if (gitArc) return gitArc;
  if (name.startsWith("subagent_")) return renderSubagent(name, args);
  if (name.startsWith("browse_")) return renderBrowse(name, args);
  switch (name) {
    case "git_arc_wait":
      return specialized("git-arc.wait", { kind: "gitArcWait", ref: readString(args.ref) });
    case "toc": {
      const file = readString(args.file) || "Markdown file";
      return simple(
        "workbench-cli.toc",
        actionTarget("Listing headings in ", file),
        actionTarget("Listed headings in ", file),
      );
    }
    case "rg":
      return {
        kind: "simple",
        rendering: {
          claimedBy: "workbench-cli.ripgrep",
          result: RipgrepCommand.presentationResult(readStringArray(args.args), context)
            ?? CommandMatcher.Result({
              ongoingSummaryParts: actionTarget("Searching ", "project files"),
              summaryParts: actionTarget("Searched ", "project files"),
              summaryStats: { searchedFiles: 1 },
            }),
        },
      };
    case "tokens":
      return simple("workbench-cli.tokens", actionTarget("Counting ", "text tokens"), actionTarget("Counted ", "text tokens"));
    case "tokens_instructions":
      return simple("workbench-cli.tokens", actionTarget("Counting ", "instruction tokens"), actionTarget("Counted ", "instruction tokens"));
    case "tokens_project":
      return simple("workbench-cli.tokens", actionTarget("Counting ", "project instruction tokens"), actionTarget("Counted ", "project instruction tokens"));
    case "thread_title_get":
      return simple("workbench-cli.thread-title-get", actionTarget("Checking ", "thread title"), actionTarget("Checked ", "thread title"));
    case "thread_title": {
      const title = readString(args.title);
      return title ? specialized("workbench-cli.thread-title-set", { kind: "threadTitle", title }) : null;
    }
    case "thread_status": {
      const status = readString(args.status);
      return status === "completed" || status === "blocked"
        ? specialized("workbench-cli.thread-status", { kind: "threadStatus", status })
        : null;
    }
    case "thread_refresh":
      return simple("workbench-cli.thread-refresh", actionTarget("Refreshing ", "thread"), actionTarget("Refreshed ", "thread"));
    case "thread_recall_search":
    case "thread_recall_expand":
    case "thread_recall":
      return specialized("thread-context.read", { kind: "threadRecall" });
    case "git_add":
      return simple("workbench-git.selection", actionTarget("Selecting ", "files for commit"), actionTarget("Selected ", "files for commit"));
    case "git_unstage":
      return simple("workbench-git.selection", actionTarget("Removing ", "files from commit selection"), actionTarget("Removed ", "files from commit selection"));
    case "git_commit":
      return simple("workbench-git.commit", actionTarget("Committing ", "selected files"), actionTarget("Committed ", "selected files"));
  }
  return null;
}

export function getWorkbenchCommandRendering(
  name: WorkbenchCommandPresentationName,
  argumentsValue: JsonValue,
  context: WorkbenchCommandPresentationContext = {},
) {
  return getWorkbenchCommandRoute(name, argumentsValue, context)?.rendering ?? null;
}

export function getWorkbenchCommandSummaryDisplay(
  name: WorkbenchCommandPresentationName,
  argumentsValue: JsonValue,
  context: WorkbenchCommandPresentationContext = {},
): ThreadCommandSummaryDisplay | null {
  return getWorkbenchCommandRouteSummaryDisplay(getWorkbenchCommandRoute(name, argumentsValue, context));
}

export function getWorkbenchCommandRouteSummaryDisplay(
  route: WorkbenchCommandRoute | null,
): ThreadCommandSummaryDisplay | null {
  if (!route || route.kind !== "simple") return null;
  const { rendering: renderingValue } = route;
  const { result } = renderingValue;
  const summaryStats = { ...createEmptyCommandSummaryStats(), ...(result.summaryStats ?? {}) };
  return {
    claimedBy: renderingValue.claimedBy,
    detailRows: result.detailRows,
    hideCommandCwd: result.hideCommandCwd,
    hideCommandOutput: result.hideCommandOutput,
    omitFromDisplay: result.omitFromDisplay ?? false,
    ongoingSummaryParts: result.ongoingSummaryParts,
    ongoingSummaryText: summarizeDisplayParts(result.ongoingSummaryParts),
    shell: null,
    showShell: false,
    summaryKind: "matched",
    summaryParts: result.summaryParts,
    summaryStats,
    summaryText: summarizeDisplayParts(result.summaryParts),
  };
}
