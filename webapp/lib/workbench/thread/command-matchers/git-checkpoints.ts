/*
 * Exports:
 * - GIT_CHECKPOINT_COMMAND_MATCHERS: command-summary matchers for wb checkpoint commands. Keywords: thread, command, matcher, git, checkpoint, cli.
 * - isGitCheckpointDiffMatcherClaim: detect checkpoint diff matcher ids for specialized command-output rendering. Keywords: thread, command, checkpoint, diff.
 * - parseGitCheckpointDiffArtifactId: parse a compact checkpoint diff summary for the stored full-diff artifact id. Keywords: checkpoint, diff, artifact.
 * - parseGitCheckpointDiffOutput: parse checkpoint diff command output into file-change display entries. Keywords: checkpoint, diff, file change.
 */

import type { FileUpdateChange } from "../../../codex/generated/app-server/v2/FileUpdateChange";
import { parseUnifiedDiffFileChanges } from "../thread-file-diff";
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

const CHECKPOINT_DIFF_MATCHER_ID = "git-checkpoint.diff";
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^Full diff artifact:\s*([a-f0-9]{64})\s*$/im;

export const GIT_CHECKPOINT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "git-checkpoint.create",
    match: ({ stage }) => {
      if (!/^wb(?:\.cmd)?\s+checkpoint\s+(?:baseline|create-diff)(?:\s|$)/iu.test(stage.text.trim())) {
        return null;
      }

      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text("Created git checkpoint")],
        summaryStats: { gitCheckpointCreates: 1 },
      });
    },
  }),
  CommandMatcher({
    id: CHECKPOINT_DIFF_MATCHER_ID,
    match: ({ stage }) => {
      if (!/^wb(?:\.cmd)?\s+checkpoint\s+(?:diff|file-diff)(?:\s|$)/iu.test(stage.text.trim())) {
        return null;
      }

      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text("Diffed against git checkpoint")],
        summaryStats: { gitCheckpointDiffs: 1 },
      });
    },
  }),
  CommandMatcher({
    id: "git-checkpoint.restore",
    match: ({ stage }) => {
      if (!/^wb(?:\.cmd)?\s+checkpoint\s+restore(?:\s|$)/iu.test(stage.text.trim())) {
        return null;
      }

      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text("Restored git checkpoint")],
        summaryStats: { gitCheckpointRestores: 1 },
      });
    },
  }),
];

export function isGitCheckpointDiffMatcherClaim(claimedBy: string | null | undefined) {
  return String(claimedBy ?? "")
    .split(",")
    .map((matcherId) => matcherId.trim())
    .includes(CHECKPOINT_DIFF_MATCHER_ID);
}

export function parseGitCheckpointDiffOutput(output: string): FileUpdateChange[] {
  return parseUnifiedDiffFileChanges(output).map((change) => ({
    diff: change.diff,
    kind: change.kind.type === "update"
      ? {
        move_path: change.kind.movePath,
        type: "update",
      }
      : { type: change.kind.type },
    path: change.path,
  }));
}

export function parseGitCheckpointDiffArtifactId(output: string) {
  return CHECKPOINT_DIFF_ARTIFACT_PATTERN.exec(String(output ?? ""))?.[1] ?? null;
}
