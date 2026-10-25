/*
 * Exports:
 * - ActivityChip: one counted kind of work in an activity run summary, with change totals for file chips.
 * - CommandChipContext: matcher context for summarising commands.
 * - getCommandIcon: one command step row's kind icon, from the same categories as the chips.
 * - getCommandItemDisplay: one command's matcher display.
 * - getActivityChips: count a run's created/edited/deleted files (unique files, in that order; applied arc edit sessions
 *   count as edited) then every step in some command chip (unnamed steps as exec), with Browse screenshots beside browser
 *   steps.
 */
import type { ComponentType } from "react";

import { parseGitArcEditText, type GitArcEditResult } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { readGitArcMcpResult } from "workbench-shared/workbench/git/git-arc-mcp-result";
import { createEmptyCommandSummaryStats, mergeCommandSummaryStats } from "../../../workbench/thread/command-matchers/helpers";
import { readMcpTextContent } from "../../../workbench/thread/command-matchers/workbench-mcp";
import {
  getGitArcMatcherAction,
  getNativeToolDisplay,
  getThreadCommandDisplay,
  getWorkbenchMcpCommandDisplay,
  getWorkbenchMcpCommandRoute,
  type ThreadCommandSummaryDisplay,
  type ThreadCommandSummaryStats,
} from "../../../workbench/thread/thread-command-matchers";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchBrowseResultEntry, WorkbenchSkillSummary } from "workbench-shared/types";
import {
  BookBookmarkIcon, BookIcon, BookSearchIcon, BrowserSessionIcon, EyeIcon, FileAddIcon, FileDeleteIcon, FileTextIcon, FileUpdateIcon,
  FolderClosedIcon, GitArcProposalIcon, GitGraphIcon, ImageIcon, SearchIcon, TerminalIcon, type IconProps,
} from "../workbench-icons";
import { getBrowseItemSteps, getBrowseScreenshots } from "./thread-browse-steps";
import { getThreadFileChangeEntries } from "./ThreadFileChangeItem";
import type { ActivitySegment, CommandSequenceItem } from "./thread-render-blocks";

export interface ActivityChip {
  additions?: number;
  count: number;
  deletions?: number;
  Icon: ComponentType<IconProps>;
  key: string;
  verb: string;
}

export interface CommandChipContext {
  /** Recorded Browse results, so Browse steps can count and show their screenshots. */
  browseResultEntries?: readonly WorkbenchBrowseResultEntry[];
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  /** The content's working directory; MCP summaries resolve paths only when it is known. */
  cwd?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

/** Chips in summary order. */
const COMMAND_CHIPS = [
  { Icon: FileTextIcon, key: "read", verb: "read" },
  { Icon: SearchIcon, key: "searched", verb: "searched" },
  { Icon: BookIcon, key: "recalled", verb: "recalled" },
  { Icon: FolderClosedIcon, key: "listed", verb: "listed" },
  { Icon: EyeIcon, key: "checked", verb: "checked" },
  { Icon: FileDeleteIcon, key: "removed", verb: "removed" },
  { Icon: GitGraphIcon, key: "git", verb: "git checks" },
  { Icon: GitArcProposalIcon, key: "arc", verb: "arc steps" },
  { Icon: BookBookmarkIcon, key: "skills", verb: "skills" },
  { Icon: BrowserSessionIcon, key: "browse", verb: "browser steps" },
  { Icon: BookSearchIcon, key: "web", verb: "web" },
  { Icon: TerminalIcon, key: "exec", verb: "exec" },
] as const satisfies ReadonlyArray<{ Icon: ComponentType<IconProps>; key: string; verb: string }>;

type CommandChipKey = typeof COMMAND_CHIPS[number]["key"];

/** Every stat names its chip, so a new stat cannot go uncounted. */
const STAT_CHIPS = {
  browseActions: "browse",
  deletedPaths: "removed",
  gitCheckpointCreates: "arc",
  gitCheckpointDiffs: "arc",
  gitCheckpointRestores: "arc",
  gitDiffChecks: "git",
  gitStatusChecks: "git",
  listedFiles: "listed",
  otherCommands: "exec",
  pathChecks: "checked",
  readFiles: "read",
  searchedFiles: "searched",
  skillLoads: "skills",
  threadRecalls: "recalled",
  visChecks: "checked",
  webRequests: "web",
} satisfies Record<keyof ThreadCommandSummaryStats, CommandChipKey>;

const STAT_KEYS = Object.keys(STAT_CHIPS) as Array<keyof ThreadCommandSummaryStats>;

function countChip(stats: ThreadCommandSummaryStats, key: CommandChipKey) {
  return STAT_KEYS.reduce((total, stat) => STAT_CHIPS[stat] === key ? total + stats[stat] : total, 0);
}

/** A command step row's kind icon: its first counted chip, else a terminal. */
export function getCommandIcon(stats: ThreadCommandSummaryStats | null | undefined): ComponentType<IconProps> {
  return (stats && COMMAND_CHIPS.find(chip => countChip(stats, chip.key) > 0)?.Icon) || TerminalIcon;
}

/** One command's matcher display, or null when no matcher describes it (own-renderer routes have none). */
export function getCommandItemDisplay(item: CommandSequenceItem, context: CommandChipContext): ThreadCommandSummaryDisplay | null {
  if (item.type === "commandExecution") {
    return getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell,
      knownSkills: context.knownSkills, projectRootPath: context.projectRootPath, workspaceRoots: context.workspaceRoots });
  }
  if (item.type === "dynamicToolCall") return getNativeToolDisplay(item, { knownSkills: context.knownSkills });
  const mcpContext = { knownSkills: context.knownSkills, ...(context.cwd
    ? { cwd: context.cwd, projectRootPath: context.projectRootPath, workspaceRoots: context.workspaceRoots } : {}) };
  return getWorkbenchMcpCommandDisplay({ argumentsValue: item.arguments, context: mcpContext, server: item.server, tool: item.tool });
}

/**
 * What one step did: its own renderer's stats, else its matcher display's. A step nothing names counts as exec, so
 * every step lands in some chip.
 */
function getCommandItemStats(item: CommandSequenceItem, context: CommandChipContext): ThreadCommandSummaryStats {
  // A shell wait repeats its command's line; what that command did is already counted once on its own row.
  if (item.type === "commandExecution" && "shellWait" in item) return { ...createEmptyCommandSummaryStats(), otherCommands: 1 };
  const route = item.type === "mcpToolCall"
    ? getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool }) : null;
  const stats = mergeCommandSummaryStats(createEmptyCommandSummaryStats(), route?.kind === "specialized"
    ? route.rendering.result.summaryStats
    : getCommandItemDisplay(item, context)?.summaryStats);
  if (!STAT_KEYS.some(stat => stats[stat] > 0)) stats.otherCommands = 1;
  return stats;
}

const FILE_CHIPS = [
  { Icon: FileAddIcon, key: "add", verb: "created" },
  { Icon: FileUpdateIcon, key: "update", verb: "edited" },
  { Icon: FileDeleteIcon, key: "delete", verb: "deleted" },
] as const;

/** The arc edit session result a step reports: MCP structured content, else the text it printed (MCP or CLI). */
function readArcEdit(item: CommandSequenceItem, context: CommandChipContext): GitArcEditResult | null {
  if (item.type === "mcpToolCall") {
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    if (route?.kind !== "specialized" || route.operation.kind !== "gitArc" || route.operation.operation.action !== "edit") return null;
    const typed = readGitArcMcpResult(item.result?.structuredContent ?? null);
    if (typed?.kind === "valid" && typed.result.kind === "success" && typed.result.edit) return typed.result.edit;
    return parseGitArcEditText((item.result?.content ?? []).flatMap(part => readMcpTextContent(part) ?? []).join("\n"));
  }
  if (item.type !== "commandExecution" || "shellWait" in item || getGitArcMatcherAction(getCommandItemDisplay(item, context)?.claimedBy) !== "edit") return null;
  return parseGitArcEditText(item.aggregatedOutput ?? "");
}

/**
 * The edit sessions a run applied and kept. Only applying changes files: previews, views and ends repeat the same totals,
 * and a session the run reverts changed nothing in the end.
 */
function appliedArcEdits(commands: readonly CommandSequenceItem[], context: CommandChipContext) {
  const sessions = new Map<string, GitArcEditResult>();
  for (const item of commands) {
    const edit = readArcEdit(item, context);
    if (edit?.phase === "applied") sessions.set(edit.session, edit);
    else if (edit?.phase === "reverted") sessions.delete(edit.session);
  }
  return [...sessions.values()];
}

/** Applied arc edits count as edited files beside ordinary edits; files past the first page are counted, not named. */
function fileChips(segments: readonly ActivitySegment[], edits: readonly GitArcEditResult[]): ActivityChip[] {
  const entries = getThreadFileChangeEntries(segments.flatMap(segment => segment.kind === "files" ? segment.items : []));
  return FILE_CHIPS.flatMap(({ Icon, key, verb }) => {
    const matching = entries.filter(entry => entry.kind === key);
    const edited = key === "update" ? edits : [];
    if (!matching.length && !edited.length) return [];
    const paths = new Set([...matching.map(entry => entry.path), ...edited.flatMap(edit => edit.files.map(file => file.path))]);
    const unnamed = edited.reduce((total, edit) => total + edit.fileCount - edit.files.length, 0);
    const additions = matching.reduce((total, entry) => total + entry.additions, 0) + edited.reduce((total, edit) => total + edit.additions, 0);
    const deletions = matching.reduce((total, entry) => total + entry.deletions, 0) + edited.reduce((total, edit) => total + edit.deletions, 0);
    return [{
      Icon, count: paths.size + unnamed, key, verb,
      ...(key !== "delete" ? { additions } : {}),
      ...(key !== "add" ? { deletions } : {}),
    }];
  });
}

export function getActivityChips(segments: readonly ActivitySegment[], context: CommandChipContext): ActivityChip[] {
  const commands = segments.flatMap(segment => segment.kind === "commands" ? segment.items : []);
  const stats = createEmptyCommandSummaryStats();
  for (const item of commands) mergeCommandSummaryStats(stats, getCommandItemStats(item, context));
  stats.webRequests += segments.reduce((total, segment) => total + (segment.kind === "webSearch" ? segment.items.length : 0), 0);
  const commandChips = COMMAND_CHIPS.flatMap(({ Icon, key, verb }) => {
    const count = countChip(stats, key);
    const chip = count ? [{ Icon, count, key, verb }] : [];
    return key === "browse" ? [...chip, ...screenshotChip(commands, context)] : chip;
  });
  return [...fileChips(segments, appliedArcEdits(commands, context)), ...commandChips];
}

/** Screenshots Browse steps captured, next to the browser steps that took them. */
function screenshotChip(commands: readonly CommandSequenceItem[], context: CommandChipContext): ActivityChip[] {
  const urls = new Set(commands.flatMap(item => getBrowseScreenshots(
    getBrowseItemSteps(item, getCommandItemDisplay(item, context), context.browseResultEntries ?? []) ?? [],
  )));
  return urls.size ? [{ Icon: ImageIcon, count: urls.size, key: "screenshots", verb: "screenshots" }] : [];
}
