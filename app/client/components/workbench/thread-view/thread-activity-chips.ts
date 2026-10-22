/*
 * Exports:
 * - ActivityChip: one counted kind of work in an activity run summary, with change totals for file chips.
 * - CommandChipContext: matcher context for summarising commands.
 * - getCommandIcon: one command step row's kind icon, from the same categories as the chips.
 * - getCommandBlockItems: command items in the shape the command matchers summarise.
 * - getCommandItemDisplay: one command's matcher display.
 * - getActivityChips: count a run's created/edited/deleted files (unique files, in that order) then its matched command categories (including
 *   merged steps with their own renderer), with Browse screenshots beside browser steps.
 */
import type { ComponentType } from "react";

import {
  getNativeToolDisplay,
  getThreadCommandBlockDisplay,
  getThreadCommandDisplay,
  getWorkbenchMcpCommandDisplay,
  getWorkbenchMcpCommandRoute,
  type ThreadCommandSummaryDisplay,
  type ThreadCommandSummaryStats,
} from "../../../workbench/thread/thread-command-matchers";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchBrowseResultEntry, WorkbenchSkillSummary } from "workbench-shared/types";
import {
  BookBookmarkIcon, BookSearchIcon, BrowserSessionIcon, EyeIcon, FileAddIcon, FileDeleteIcon, FileTextIcon, FileUpdateIcon,
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

/** Matcher categories in summary order; each chip counts every stat it names. */
const COMMAND_CHIPS: ReadonlyArray<{ Icon: ComponentType<IconProps>; key: string; stats: ReadonlyArray<keyof ThreadCommandSummaryStats>; verb: string }> = [
  { Icon: FileTextIcon, key: "read", stats: ["readFiles"], verb: "read" },
  { Icon: SearchIcon, key: "searched", stats: ["searchedFiles"], verb: "searched" },
  { Icon: FolderClosedIcon, key: "listed", stats: ["listedFiles"], verb: "listed" },
  { Icon: EyeIcon, key: "checked", stats: ["pathChecks", "visChecks"], verb: "checked" },
  { Icon: FileDeleteIcon, key: "removed", stats: ["deletedPaths"], verb: "removed" },
  { Icon: GitGraphIcon, key: "git", stats: ["gitStatusChecks", "gitDiffChecks"], verb: "git checks" },
  { Icon: GitArcProposalIcon, key: "arc", stats: ["gitCheckpointCreates", "gitCheckpointDiffs", "gitCheckpointRestores"], verb: "arc steps" },
  { Icon: BookBookmarkIcon, key: "skills", stats: ["skillLoads"], verb: "skills" },
  { Icon: BrowserSessionIcon, key: "browse", stats: ["browseActions"], verb: "browser steps" },
  { Icon: BookSearchIcon, key: "web", stats: ["webRequests"], verb: "web" },
  { Icon: TerminalIcon, key: "ran", stats: ["otherCommands"], verb: "ran" },
];

/** A command step row's kind icon: its first counted category, else a terminal. */
export function getCommandIcon(stats: ThreadCommandSummaryStats | null | undefined): ComponentType<IconProps> {
  return (stats && COMMAND_CHIPS.find(chip => chip.stats.some(stat => stats[stat] > 0))?.Icon) || TerminalIcon;
}

/** One command's matcher display, or null when no matcher describes it. */
export function getCommandItemDisplay(item: CommandSequenceItem, context: CommandChipContext): ThreadCommandSummaryDisplay | null {
  const [entry] = getCommandBlockItems([item], context);
  if (!entry) return null;
  return "display" in entry ? entry.display : getThreadCommandDisplay({ ...entry, knownSkills: context.knownSkills,
    projectRootPath: context.projectRootPath, workspaceRoots: context.workspaceRoots });
}

type CommandBlockItem = Parameters<typeof getThreadCommandBlockDisplay>[0]["items"][number];

export function getCommandBlockItems(items: readonly CommandSequenceItem[], context: CommandChipContext): CommandBlockItem[] {
  const mcpContext = { knownSkills: context.knownSkills, ...(context.cwd
    ? { cwd: context.cwd, projectRootPath: context.projectRootPath, workspaceRoots: context.workspaceRoots } : {}) };
  return items.flatMap<CommandBlockItem>(item => {
    if (item.type === "commandExecution") {
      return [{ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell }];
    }
    const display = item.type === "dynamicToolCall"
      ? getNativeToolDisplay(item, { knownSkills: context.knownSkills })
      : getWorkbenchMcpCommandDisplay({ argumentsValue: item.arguments, context: mcpContext, server: item.server, tool: item.tool });
    return display ? [{ display }] : [];
  });
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
  const searches = segments.reduce((total, segment) => total + (segment.kind === "webSearch" ? segment.items.length : 0), 0);
  const stats = commands.length
    ? getThreadCommandBlockDisplay({ items: getCommandBlockItems(commands, context), ...context }).summaryStats
    : null;
  const ownRowStats = dedicatedRendererStats(commands);
  const commandChips = COMMAND_CHIPS.flatMap(({ Icon, key, stats: statKeys, verb }) => {
    const count = statKeys.reduce((total, stat) => total + (stats?.[stat] ?? 0) + ownRowStats.reduce((sum, entry) => sum + (entry[stat] ?? 0), 0), 0)
      + (key === "web" ? searches : 0);
    const chip = count ? [{ Icon, count, key, verb }] : [];
    return key === "browse" ? [...chip, ...screenshotChip(commands, context)] : chip;
  });
  return [...fileChips(segments), ...commandChips];
}

/** wb MCP calls drawn by their own renderer (arc reads, vis, recall) have no summary display, yet still count what they did. */
function dedicatedRendererStats(commands: readonly CommandSequenceItem[]): Partial<ThreadCommandSummaryStats>[] {
  return commands.flatMap(item => {
    if (item.type !== "mcpToolCall") return [];
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    return route?.kind === "specialized" && route.rendering.result.summaryStats ? [route.rendering.result.summaryStats] : [];
  });
}

/** Screenshots Browse steps captured, next to the browser steps that took them. */
function screenshotChip(commands: readonly CommandSequenceItem[], context: CommandChipContext): ActivityChip[] {
  const urls = new Set(commands.flatMap(item => getBrowseScreenshots(
    getBrowseItemSteps(item, getCommandItemDisplay(item, context), context.browseResultEntries ?? []) ?? [],
  )));
  return urls.size ? [{ Icon: ImageIcon, count: urls.size, key: "screenshots", verb: "screenshots" }] : [];
}
