/*
 * Exports:
 * - ActivityChip: one counted kind of work in an activity run summary, with change totals for file chips.
 * - CommandChipContext: matcher context for summarising commands.
 * - getCommandIcon: one command step row's kind icon, from the same categories as the chips.
 * - getCommandItemDisplay: one command's matcher display.
 * - getActivityChips: count a run's created/edited/deleted files (unique files, in that order) then every step in some command chip
 *   (unnamed steps as exec), with Browse screenshots beside browser steps.
 */
import type { ComponentType } from "react";

import { createEmptyCommandSummaryStats, mergeCommandSummaryStats } from "../../../workbench/thread/command-matchers/helpers";
import {
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

function fileChips(segments: readonly ActivitySegment[]): ActivityChip[] {
  const entries = getThreadFileChangeEntries(segments.flatMap(segment => segment.kind === "files" ? segment.items : []));
  return FILE_CHIPS.flatMap(({ Icon, key, verb }) => {
    const matching = entries.filter(entry => entry.kind === key);
    if (!matching.length) return [];
    const additions = matching.reduce((total, entry) => total + entry.additions, 0);
    const deletions = matching.reduce((total, entry) => total + entry.deletions, 0);
    return [{
      Icon, count: new Set(matching.map(entry => entry.path)).size, key, verb,
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
  return [...fileChips(segments), ...commandChips];
}

/** Screenshots Browse steps captured, next to the browser steps that took them. */
function screenshotChip(commands: readonly CommandSequenceItem[], context: CommandChipContext): ActivityChip[] {
  const urls = new Set(commands.flatMap(item => getBrowseScreenshots(
    getBrowseItemSteps(item, getCommandItemDisplay(item, context), context.browseResultEntries ?? []) ?? [],
  )));
  return urls.size ? [{ Icon: ImageIcon, count: urls.size, key: "screenshots", verb: "screenshots" }] : [];
}
