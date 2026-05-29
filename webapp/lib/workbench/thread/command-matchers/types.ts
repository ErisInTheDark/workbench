/*
 * Exports:
 * - CommandShell: shell launcher id recognized by thread command summaries. Keywords: thread, command, shell.
 * - CommandShellGroup: shell family used for stage consumption and matcher selection. Keywords: thread, command, shell, matcher.
 * - CommandPathDisplayPart: structured path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - CommandSeparatorDisplayPart: structured stage-separator part for procedural command summaries. Keywords: thread, command, summary, separator.
 * - ThreadCommandDisplayPart: structured text/path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
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
  variant?: "code" | "plain";
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

export interface ThreadCommandSummaryStats {
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
