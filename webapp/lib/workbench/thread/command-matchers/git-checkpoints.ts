/*
 * Exports:
 * - GIT_CHECKPOINT_COMMAND_MATCHERS: distinct command summaries for plan, implement, compare, diff, commit, and restore. Keywords: thread, command, matcher, git checkpoint.
 * - isGitCheckpointCompareMatcherClaim/isGitCheckpointDiffMatcherClaim/isGitCheckpointCommitMatcherClaim: detect specialized checkpoint renderers. Keywords: checkpoint, matcher, renderer.
 * - parseGitCheckpointCompareOutput: parse per-file checkpoint change counts. Keywords: checkpoint, compare, additions, deletions.
 * - parseGitCheckpointProposalId: parse the durable proposal id from CLI output. Keywords: checkpoint, proposal, commit.
 * - parseGitCheckpointCommitCommand/GitCheckpointCommitCommandIntent: read immediate proposal-card intent from canonical command arguments. Keywords: checkpoint, proposal, title, paths.
 * - parseGitCheckpointDiffArtifactId/parseGitCheckpointDiffOutput: preserve legacy and inline unified diff rendering. Keywords: checkpoint, diff, artifact.
 */
import type { FileUpdateChange } from "../../../codex/generated/app-server/v2/FileUpdateChange";
import { parseUnifiedDiffFileChanges } from "../thread-file-diff";
import { CommandMatcher } from "./core";
import { tokenizeCommand } from "./helpers";
import type { CommandMatcherDefinition } from "./types";

const CHECKPOINT_COMPARE_MATCHER_ID = "git-checkpoint.compare";
const CHECKPOINT_DIFF_MATCHER_ID = "git-checkpoint.diff";
const CHECKPOINT_COMMIT_MATCHER_ID = "git-checkpoint.commit";
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^Full diff artifact:\s*([a-f0-9]{64})\s*$/im;
const CHECKPOINT_PROPOSAL_PATTERN = /^Workbench checkpoint proposal:\s*([A-Za-z0-9._-]+)\s*$/im;
const CHECKPOINT_COMPARE_LINE_PATTERN = /^([ADMU])\t\+(\d+)\t-(\d+)\t(.+)$/u;

export interface GitCheckpointCommitCommandIntent {
  checkpointCommit: string;
  description: string;
  paths: string[];
  title: string;
}

function createMatcher({
  command,
  id,
  ongoing,
  summary,
  stats,
}: {
  command: string;
  id: string;
  ongoing: string;
  stats?: { gitCheckpointCreates?: number; gitCheckpointDiffs?: number; gitCheckpointRestores?: number };
  summary: string;
}): CommandMatcherDefinition {
  return CommandMatcher({
    id,
    match: ({ stage }) => {
      if (!new RegExp(`^wb(?:\\.cmd)?\\s+(?:git\\s+)?checkpoint\\s+${command}(?:\\s|$)`, "iu").test(stage.text.trim())) return null;
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
    command: "baseline",
    id: "git-checkpoint.baseline-migration",
    ongoing: "Reading checkpoint migration guide",
    summary: "Read checkpoint migration guide",
  }),
  createMatcher({
    command: "plan",
    id: "git-checkpoint.plan",
    ongoing: "Creating plan checkpoint",
    stats: { gitCheckpointCreates: 1 },
    summary: "Created plan checkpoint",
  }),
  createMatcher({
    command: "implement",
    id: "git-checkpoint.implement",
    ongoing: "Creating implementation checkpoint",
    stats: { gitCheckpointCreates: 1 },
    summary: "Created implementation checkpoint",
  }),
  createMatcher({
    command: "compare",
    id: CHECKPOINT_COMPARE_MATCHER_ID,
    ongoing: "Comparing against git checkpoint",
    stats: { gitCheckpointDiffs: 1 },
    summary: "Compared against git checkpoint",
  }),
  createMatcher({
    command: "diff",
    id: CHECKPOINT_DIFF_MATCHER_ID,
    ongoing: "Diffing against git checkpoint",
    stats: { gitCheckpointDiffs: 1 },
    summary: "Diffed against git checkpoint",
  }),
  createMatcher({
    command: "commit",
    id: CHECKPOINT_COMMIT_MATCHER_ID,
    ongoing: "Creating checkpoint commit proposal",
    summary: "Proposed checkpoint commit",
  }),
  createMatcher({
    command: "restore",
    id: "git-checkpoint.restore",
    ongoing: "Restoring git checkpoint",
    stats: { gitCheckpointRestores: 1 },
    summary: "Restored git checkpoint",
  }),
];

function includesMatcher(claimedBy: string | null | undefined, matcherId: string) {
  return String(claimedBy ?? "").split(",").map((value) => value.trim()).includes(matcherId);
}

export function isGitCheckpointCompareMatcherClaim(claimedBy: string | null | undefined) {
  return includesMatcher(claimedBy, CHECKPOINT_COMPARE_MATCHER_ID);
}

export function isGitCheckpointDiffMatcherClaim(claimedBy: string | null | undefined) {
  return includesMatcher(claimedBy, CHECKPOINT_DIFF_MATCHER_ID);
}

export function isGitCheckpointCommitMatcherClaim(claimedBy: string | null | undefined) {
  return includesMatcher(claimedBy, CHECKPOINT_COMMIT_MATCHER_ID);
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
  if (tokens[cursor] !== "checkpoint" || tokens[cursor + 1] !== "commit") return null;
  cursor += 2;

  let checkpointCommit = "";
  const messages: string[] = [];
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    const value = tokens[cursor + 1];
    if ((flag !== "--sha" && flag !== "--m") || !value) return null;
    if (flag === "--sha") checkpointCommit = value;
    else messages.push(value);
    cursor += 1;
  }
  if (tokens[cursor] !== "--") return null;
  const paths = tokens.slice(cursor + 1);
  if (!checkpointCommit || messages.length < 1 || messages.length > 2 || !paths.length) return null;
  return {
    checkpointCommit,
    description: messages[1] ?? "",
    paths,
    title: messages[0],
  };
}

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
