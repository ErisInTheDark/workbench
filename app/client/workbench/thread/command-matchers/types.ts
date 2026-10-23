/*
 * Exports:
 * - CommandShell: shell launcher id recognized by thread command summaries.
 * - CommandShellGroup: shell family used for stage consumption and matcher selection.
 * - CommandPathDisplayPart: structured path part for rendering command summaries with file pills.
 * - CommandPatternDisplayPart: structured literal or regex pattern rendered as one syntax-aware code pill.
 * - CommandTextDisplayPart: styled text part for plain, code, or primary command-summary text.
 * - CommandSkillDisplayPart: structured skill reference rendered inside command summaries.
 * - CommandThreadDisplayPart: thread id rendered as a link to that thread.
 * - CommandSeparatorDisplayPart: structured stage-separator part for procedural command summaries.
 * - ThreadCommandDisplayPart: any one part of a command summary.
 * - ThreadCommandDetailResultKind: semantic detail result kinds for polished command substep rows.
 * - ThreadCommandDetailState: lifecycle state for command substep rows.
 * - ThreadCommandDetailTarget: semantic target metadata for polished command substep rows.
 * - ThreadCommandDetailRow: optional row rendered inside command disclosures for structured command substeps.
 * - ThreadCommandSummaryStats: aggregate command-summary counts for grouped command labels.
 * - ThreadCommandSummaryDisplay: shared summary-display metadata for single-command and grouped command labels, including dedicated-row ownership.
 * - ThreadCommandDisplay: parsed command-summary metadata for single thread command rendering.
 * - CommandDisplayContext: public input for thread command display parsing.
 * - ParsedCommandDisplayContext: unwrapped command context shared by matcher helpers.
 * - CommandStage: next consumable command stage plus trailing remainder.
 * - CommandMatcherContext: matcher input including current stage and accumulated summary parts.
 * - CommandMatcherResult: matcher output with rendered parts, aggregate counts, and optional remaining command.
 * - CommandMatcherDefinition: shell-stage matcher definition for thread command summaries.
 */

import type { CommandAction } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchSkillSummary } from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../markdown/markdown-links";

export type CommandShell =
  | "bash"
  | "cmd"
  | "fish"
  | "powershell"
  | "pwsh"
  | "sh"
  | "shell"
  | "zsh"
  | null;

export type CommandShellGroup = "cmd" | "posix" | "powershell" | "unknown";

export interface CommandPathDisplayPart {
  columnNumber?: number | null;
  label?: string;
  lineNumber?: number | null;
  path: string;
  type: "path";
}

export interface CommandSeparatorDisplayPart {
  kind: "stage";
  type: "separator";
}

export interface CommandTextDisplayPart {
  clamp?: boolean;
  text: string;
  type: "text";
  variant?: "code" | "plain" | "primary";
}

export interface CommandPatternDisplayPart {
  pattern: string;
  syntax: "literal" | "regex";
  type: "pattern";
}

export interface CommandSkillDisplayPart {
  name: string;
  path: string;
  type: "skill";
}

export interface CommandThreadDisplayPart {
  threadId: string;
  type: "thread";
}

export type ThreadCommandDisplayPart =
  | CommandTextDisplayPart
  | CommandSkillDisplayPart
  | CommandThreadDisplayPart
  | CommandPathDisplayPart
  | CommandPatternDisplayPart
  | CommandSeparatorDisplayPart;

export type ThreadCommandDetailResultKind = "duration" | "error" | "result" | "text";

export type ThreadCommandDetailState = "completed" | "failed" | "inProgress" | "queued";

export interface ThreadCommandDetailTarget {
  kind: "code" | "text" | "url";
  text: string;
}

export interface ThreadCommandDetailRow {
  /** Machine action name (e.g. a BrowseMD command), for presentation lookups such as icons. */
  action?: string | null;
  contextText?: string | null;
  /** The row's content is the point of the step (an explicit screenshot), so it shows open. */
  defaultOpen?: boolean;
  detailKind?: ThreadCommandDetailResultKind;
  detailLabel?: string | null;
  detailText?: string | null;
  durationMs?: number | null;
  id: string;
  imageUrl?: string | null;
  imageUrls?: readonly string[] | null;
  label?: string | null;
  state?: ThreadCommandDetailState | null;
  summaryParts: ThreadCommandDisplayPart[];
  target?: ThreadCommandDetailTarget | null;
}

export interface ThreadCommandSummaryStats {
  browseActions: number;
  deletedPaths: number;
  gitCheckpointCreates: number;
  gitCheckpointDiffs: number;
  gitCheckpointRestores: number;
  gitDiffChecks: number;
  gitStatusChecks: number;
  listedFiles: number;
  otherCommands: number;
  pathChecks: number;
  readFiles: number;
  searchedFiles: number;
  skillLoads: number;
  threadRecalls: number;
  visChecks: number;
  webRequests: number;
}

export interface ThreadCommandSummaryDisplay {
  claimedBy: string | null;
  detailRows?: ThreadCommandDetailRow[];
  hideCommandCwd?: boolean;
  hideCommandOutput?: boolean;
  omitFromDisplay: boolean;
  /** A dedicated renderer draws this command; an omitted summary must not hide it, and it groups only when a stat names it. */
  ownRow?: boolean;
  /** Leads with its gerund (`Reading …`, after any `cwd: ` prefix); the thread status row shows that word alone. */
  ongoingSummaryParts: ThreadCommandDisplayPart[];
  ongoingSummaryText: string;
  shell: CommandShell;
  showShell: boolean;
  summaryParts: ThreadCommandDisplayPart[];
  summaryKind: "matched" | "raw";
  summaryStats: ThreadCommandSummaryStats;
  summaryText: string;
}

export interface ThreadCommandDisplay extends ThreadCommandSummaryDisplay {
  cwdDisplay: string | null;
  fullCommand: string;
  unwrappedCommand: string;
}

export interface CommandDisplayContext {
  command: string;
  commandActions: CommandAction[];
  cwd: string;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  shell?: CommandShell;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

export interface ParsedCommandDisplayContext extends CommandDisplayContext {
  cwdDisplay: string | null;
  shell: CommandShell;
  shellGroup: CommandShellGroup;
  unwrappedCommand: string;
}

export interface CommandStage {
  remainingCommand: string | null;
  text: string;
}

export interface CommandMatcherContext extends ParsedCommandDisplayContext {
  stage: CommandStage;
  summaryParts: ThreadCommandDisplayPart[];
}

export interface CommandMatcherResult {
  detailRows?: ThreadCommandDetailRow[];
  hideCommandCwd?: boolean;
  hideCommandOutput?: boolean;
  hide?: boolean;
  omitFromDisplay?: boolean;
  /** See `ThreadCommandSummaryDisplay.ownRow`. */
  ownRow?: boolean;
  ongoingSummaryParts: ThreadCommandDisplayPart[];
  remainingCommand?: string | null;
  stop?: boolean;
  summaryParts: ThreadCommandDisplayPart[];
  summaryStats?: Partial<ThreadCommandSummaryStats>;
}

export interface CommandMatcherDefinition {
  id: string;
  match: (context: CommandMatcherContext) => CommandMatcherResult | null;
}
