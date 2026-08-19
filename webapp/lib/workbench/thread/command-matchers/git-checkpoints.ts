/*
 * Exports:
 * - GIT_CHECKPOINT_COMMAND_MATCHERS: distinct command summaries for named arc plan and lifecycle operations. Keywords: thread, command, matcher, git arc.
 * - getGitArcMatcherAction/isGitCheckpointCompareMatcherClaim/isGitCheckpointDiffMatcherClaim/isGitCheckpointCommitMatcherClaim: detect specialized arc renderers. Keywords: git, arc, matcher, renderer.
 * - parseGitArcCommand/GitArcCommandIntent: read canonical arc action, ref, name, and selected paths. Keywords: git, arc, command, parser.
 * - parseGitArcReceipt: decode persisted successful arc presentation metadata. Keywords: git, arc, receipt, parser.
 * - parseGitCheckpointCompareOutput: parse per-file checkpoint change counts. Keywords: checkpoint, compare, additions, deletions.
 * - parseGitCheckpointProposalId: parse the durable proposal id from CLI output. Keywords: checkpoint, proposal, commit.
 * - parseGitCheckpointCommitCommand/GitCheckpointCommitCommandIntent: read immediate proposal-card intent from canonical command arguments. Keywords: checkpoint, proposal, title, paths.
 * - parseGitCheckpointDiffArtifactId/parseGitCheckpointDiffOutput: preserve legacy and inline unified diff rendering. Keywords: checkpoint, diff, artifact.
 */
import type { FileUpdateChange } from "../../../codex/generated/app-server/v2/FileUpdateChange";
import {
  parseGitArcReceipt,
  type GitArcAction,
} from "../../git/git-arc-receipts";
import { parseUnifiedDiffFileChanges } from "../thread-file-diff";
import { CommandMatcher } from "./core";
import { tokenizeCommand } from "./helpers";
import type { CommandMatcherDefinition } from "./types";

const ARC_MATCHER_IDS = {
  add: "git-arc.add",
  compare: "git-arc.compare",
  diff: "git-arc.diff",
  plan: "git-arc.plan",
  propose: "git-arc.propose",
  remove: "git-arc.remove",
  restore: "git-arc.restore",
  start: "git-arc.start",
} as const satisfies Record<GitArcAction, string>;
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^Full diff artifact:\s*([a-f0-9]{64})\s*$/im;
const CHECKPOINT_PROPOSAL_PATTERN = /^Workbench arc proposal:\s*([A-Za-z0-9._-]+)\s*$/im;
const CHECKPOINT_COMPARE_LINE_PATTERN = /^([ADMU])\t\+(\d+)\t-(\d+)\t(.+)$/u;

export interface GitCheckpointCommitCommandIntent {
  checkpointCommit: string;
  description: string;
  paths: string[];
  title: string;
}

export interface GitArcCommandIntent {
  action: GitArcAction;
  intentName: string | null;
  paths: string[];
  ref: string | null;
}

function createMatcher({
  commandPattern,
  id,
  ongoing,
  summary,
  stats,
}: {
  commandPattern: RegExp;
  id: string;
  ongoing: string;
  stats?: { gitCheckpointCreates?: number; gitCheckpointDiffs?: number; gitCheckpointRestores?: number };
  summary: string;
}): CommandMatcherDefinition {
  return CommandMatcher({
    id,
    match: ({ stage }) => {
      if (!commandPattern.test(stage.text.trim())) return null;
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(ongoing)],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(summary)],
        ...(stats ? { summaryStats: stats } : {}),
      });
    },
  });
}

export const GIT_CHECKPOINT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+plan(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.plan,
    ongoing: "Creating Git plan",
    stats: { gitCheckpointCreates: 1 },
    summary: "Created Git plan",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+start(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.start,
    ongoing: "Checking Git arc",
    stats: { gitCheckpointDiffs: 1 },
    summary: "Checked Git arc",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+add(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.add,
    ongoing: "Extending Git arc",
    stats: { gitCheckpointCreates: 1 },
    summary: "Extended Git arc",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+remove(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.remove,
    ongoing: "Reducing Git arc",
    stats: { gitCheckpointCreates: 1 },
    summary: "Reduced Git arc",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+compare(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.compare,
    ongoing: "Comparing Git arc",
    stats: { gitCheckpointDiffs: 1 },
    summary: "Compared Git arc",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+diff(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.diff,
    ongoing: "Diffing Git arc",
    stats: { gitCheckpointDiffs: 1 },
    summary: "Diffed Git arc",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+propose(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.propose,
    ongoing: "Creating arc commit proposal",
    summary: "Proposed arc commit",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+restore(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.restore,
    ongoing: "Restoring Git arc",
    stats: { gitCheckpointRestores: 1 },
    summary: "Restored Git arc",
  }),
];

function includesMatcher(claimedBy: string | null | undefined, matcherId: string) {
  return String(claimedBy ?? "").split(",").map((value) => value.trim()).includes(matcherId);
}

export function isGitCheckpointCompareMatcherClaim(claimedBy: string | null | undefined) {
  return includesMatcher(claimedBy, ARC_MATCHER_IDS.start) || includesMatcher(claimedBy, ARC_MATCHER_IDS.compare);
}

export function isGitCheckpointDiffMatcherClaim(claimedBy: string | null | undefined) {
  return includesMatcher(claimedBy, ARC_MATCHER_IDS.diff);
}

export function isGitCheckpointCommitMatcherClaim(claimedBy: string | null | undefined) {
  return includesMatcher(claimedBy, ARC_MATCHER_IDS.propose);
}

export function getGitArcMatcherAction(claimedBy: string | null | undefined): GitArcAction | null {
  for (const [action, matcherId] of Object.entries(ARC_MATCHER_IDS) as Array<[GitArcAction, string]>) {
    if (includesMatcher(claimedBy, matcherId)) return action;
  }
  return null;
}

export function parseGitArcCommand(command: string): GitArcCommandIntent | null {
  const tokens = tokenizeCommand(String(command ?? "").trim());
  if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")) return null;
  let cursor = tokens[1] === "git" ? 2 : 1;
  if (tokens[cursor] !== "arc") return null;
  const action = tokens[cursor + 1] as GitArcAction | undefined;
  if (!action || !(action in ARC_MATCHER_IDS)) return null;
  cursor += 2;

  let intentName: string | null = null;
  let ref: string | null = null;
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    const value = tokens[cursor + 1];
    if (!value || (flag !== "--ref" && flag !== "-m")) return null;
    if (flag === "--ref") {
      if (ref) return null;
      ref = value;
    } else if (action === "plan" && intentName === null) {
      intentName = value;
    }
    cursor += 1;
  }
  const paths = tokens[cursor] === "--" ? tokens.slice(cursor + 1) : [];
  if (action === "plan") return intentName && paths.length ? { action, intentName, paths, ref: null } : null;
  if (!ref) return null;
  return { action, intentName: null, paths, ref };
}

export function parseGitCheckpointCompareOutput(output: string) {
  return String(output ?? "").split(/\r?\n/u).flatMap((line) => {
    const match = CHECKPOINT_COMPARE_LINE_PATTERN.exec(line);
    if (!match) return [];
    return [{
      additions: Number(match[2]),
      deletions: Number(match[3]),
      path: match[4],
      status: match[1] as "A" | "D" | "M" | "U",
    }];
  });
}

export function parseGitCheckpointProposalId(output: string) {
  return CHECKPOINT_PROPOSAL_PATTERN.exec(String(output ?? ""))?.[1] ?? null;
}

export function parseGitCheckpointCommitCommand(command: string): GitCheckpointCommitCommandIntent | null {
  const tokens = tokenizeCommand(String(command ?? "").trim());
  if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")) return null;
  let cursor = 1;
  if (tokens[cursor] === "git") cursor += 1;
  if (tokens[cursor] !== "arc" || tokens[cursor + 1] !== "propose") return null;
  cursor += 2;

  let checkpointCommit = "";
  const messages: string[] = [];
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    const value = tokens[cursor + 1];
    if ((flag !== "--ref" && flag !== "-m") || !value) return null;
    if (flag === "--ref") checkpointCommit = value;
    else messages.push(value);
    cursor += 1;
  }
  const paths = tokens[cursor] === "--" ? tokens.slice(cursor + 1) : [];
  if (!checkpointCommit || messages.length < 1 || messages.length > 2) return null;
  return {
    checkpointCommit,
    description: messages[1] ?? "",
    paths,
    title: messages[0],
  };
}

export { parseGitArcReceipt };

export function parseGitCheckpointDiffOutput(output: string): FileUpdateChange[] {
  return parseUnifiedDiffFileChanges(output).map((change) => ({
    diff: change.diff,
    kind: change.kind.type === "update"
      ? { move_path: change.kind.movePath, type: "update" }
      : { type: change.kind.type },
    path: change.path,
  }));
}

export function parseGitCheckpointDiffArtifactId(output: string) {
  return CHECKPOINT_DIFF_ARTIFACT_PATTERN.exec(String(output ?? ""))?.[1] ?? null;
}
