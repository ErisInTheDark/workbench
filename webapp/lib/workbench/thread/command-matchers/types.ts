/*
 * Exports:
 * - CommandShell: shell launcher id recognized by thread command summaries. Keywords: thread, command, shell.
 * - CommandShellGroup: shell family used for stage consumption and matcher selection. Keywords: thread, command, shell, matcher.
 * - CommandPathDisplayPart: structured path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - CommandSeparatorDisplayPart: structured stage-separator part for procedural command summaries. Keywords: thread, command, summary, separator.
 * - ThreadCommandDisplayPart: structured text/path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - ThreadCommandDetailResultKind: semantic detail result kinds for polished command substep rows. Keywords: thread, command, detail, result.
 * - ThreadCommandDetailState: lifecycle state for command substep rows. Keywords: thread, command, detail, queued, progress.
 * - ThreadCommandDetailTarget: semantic target metadata for polished command substep rows. Keywords: thread, command, detail, target.
 * - ThreadCommandDetailRow: optional row rendered inside command disclosures for structured command substeps. Keywords: thread, command, details, sequence.
 * - ThreadCommandSummaryStats: aggregate command-summary counts for grouped command labels. Keywords: thread, command, summary, aggregate.
 * - ThreadCommandSummaryDisplay: shared summary-display metadata for single-command and grouped command labels. Keywords: thread, command, summary, shell.
 * - ThreadCommandDisplay: parsed command-summary metadata for single thread command rendering. Keywords: thread, command, summary, shell, omit.
 * - CommandDisplayContext: public input for thread command display parsing. Keywords: thread, command, context.
 * - ParsedCommandDisplayContext: unwrapped command context shared by matcher helpers. Keywords: thread, command, context.
 * - CommandStage: next consumable command stage plus trailing remainder. Keywords: thread, command, stage.
 * - CommandMatcherContext: matcher input including current stage and accumulated summary parts. Keywords: thread, command, matcher, context.
 * - CommandMatcherResult: matcher output with rendered parts, aggregate counts, and optional remaining command. Keywords: thread, command, matcher, result.
 * - CommandMatcherDefinition: shell-stage matcher definition for thread command summaries. Keywords: thread, command, matcher, definition.
 */

import type { CommandAction } from "../../../codex/generated/app-server/v2/CommandAction";
import type { WorkbenchSkillSummary } from "../../../types";
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

export interface CommandSkillDisplayPart {
  name: string;
  path: string;
  type: "skill";
}

export type ThreadCommandDisplayPart =
  | CommandTextDisplayPart
  | CommandSkillDisplayPart
  | CommandPathDisplayPart
  | CommandSeparatorDisplayPart;

export type ThreadCommandDetailResultKind = "duration" | "error" | "result" | "text";

export type ThreadCommandDetailState = "completed" | "failed" | "inProgress" | "queued";

export interface ThreadCommandDetailTarget {
  kind: "code" | "text" | "url";
  text: string;
}

export interface ThreadCommandDetailRow {
  contextText?: string | null;
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
  typescriptBuilds: number;
  typescriptValidations: number;
  webRequests: number;
}

export interface ThreadCommandSummaryDisplay {
  claimedBy: string | null;
  detailRows?: ThreadCommandDetailRow[];
  hideCommandCwd?: boolean;
  hideCommandOutput?: boolean;
  omitFromDisplay: boolean;
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
  remainingCommand?: string | null;
  stop?: boolean;
  summaryParts: ThreadCommandDisplayPart[];
  summaryStats?: Partial<ThreadCommandSummaryStats>;
}

export interface CommandMatcherDefinition {
  id: string;
  match: (context: CommandMatcherContext) => CommandMatcherResult | null;
}
