/*
 * Exports:
 * - GIT_CHECKPOINT_COMMAND_MATCHERS: distinct command summaries for named arc plan and lifecycle operations. Keywords: thread, command, matcher, git arc.
 * - getGitArcMatcherAction/isGitCheckpointCompareMatcherClaim/isGitCheckpointDiffMatcherClaim/isGitCheckpointCommitMatcherClaim: detect specialized arc renderers. Keywords: git, arc, matcher, renderer.
 * - parseGitArcCommand/GitArcCommandIntent/GitArcCommandAction: read canonical arc presentation action, ref, name, proposal, ordinary paths, and adopted paths. Keywords: git, arc, command, parser, adoption.
 * - parseGitArcReceipt: decode persisted successful arc presentation metadata. Keywords: git, arc, receipt, parser.
 * - parseGitCheckpointCompareOutput: parse per-file checkpoint change counts. Keywords: checkpoint, compare, additions, deletions.
 * - parseGitCheckpointProposalId: parse the durable proposal id from CLI output. Keywords: checkpoint, proposal, commit.
 * - parseGitCheckpointCommitCommand/GitCheckpointCommitCommandIntent: read immediate proposal-card intent from canonical command arguments. Keywords: checkpoint, proposal, title, paths.
 * - parseGitCheckpointDiffArtifactId/parseGitCheckpointDiffOutput: preserve legacy and inline unified diff rendering while excluding inspection trailers. Keywords: checkpoint, diff, artifact, trailer.
 */
import type { FileUpdateChange } from "../../../codex/generated/app-server/v2/FileUpdateChange";
import {
  parseGitArcReceipt,
  type GitArcAction,
} from "../../git/git-arc-receipts";
import { GIT_ARC_DIFF_TRAILER_PREFIX } from "../../git/git-arc-diff-pages";
import { parseGitArcMoveArguments, type GitArcMoveArguments } from "../../git/git-arc-move-arguments";
import { parseUnifiedDiffFileChanges } from "../thread-file-diff";
import { CommandMatcher } from "./core";
import { tokenizeCommand } from "./helpers";
import { unwrapLeadingPowerShellLiteralHereStringAssignment } from "./shells";
import type { CommandMatcherDefinition } from "./types";
import { getWorkbenchCommandRendering, type WorkbenchCommandPresentationName } from "./workbench-command-rendering";

export type GitArcCommandAction = GitArcAction | "planAdd" | "planAdopt" | "planRemove" | "planStart" | "rescind";

const ARC_MATCHER_IDS = {
  add: "git-arc.add",
  adopt: "git-arc.adopt",
  compare: "git-arc.compare",
  continue: "git-arc.continue",
  diff: "git-arc.diff",
  mv: "git-arc.mv",
  plan: "git-arc.plan",
  propose: "git-arc.propose",
  release: "git-arc.release",
  remove: "git-arc.remove",
  restore: "git-arc.restore",
  start: "git-arc.start",
  planAdd: "git-arc.plan-add",
  planAdopt: "git-arc.plan-adopt",
  planRemove: "git-arc.plan-remove",
  planStart: "git-arc.plan-start",
  rescind: "git-arc.rescind",
} as const satisfies Record<GitArcCommandAction, string>;
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^Full diff artifact:\s*([a-f0-9]{64})\s*$/im;
const CHECKPOINT_PROPOSAL_PATTERN = /^Workbench arc proposal:\s*([A-Za-z0-9._-]+)\s*$/im;
const CHECKPOINT_COMPARE_LINE_PATTERN = /^([ADMU])\t\+(\d+)\t-(\d+)\t(.+)$/u;

export interface GitCheckpointCommitCommandIntent {
  amend: boolean;
  description: string;
  paths: string[];
  rootId?: string;
  title: string;
}

export interface GitArcCommandIntent {
  action: GitArcCommandAction;
  adoptPaths?: string[];
  disown?: boolean;
  intentName: string | null;
  move?: GitArcMoveArguments;
  paths: string[];
  proposalId?: string | null;
  ref: string | null;
}

function createMatcher({
  commandPattern,
  id,
  presentationName,
}: {
  commandPattern: RegExp;
  id: string;
  presentationName: WorkbenchCommandPresentationName;
}): CommandMatcherDefinition {
  return CommandMatcher({
    id,
    match: ({ stage }) => {
      if (!commandPattern.test(stage.text.trim())) return null;
      return getWorkbenchCommandRendering(presentationName, {})?.result ?? null;
    },
  });
}

export const GIT_CHECKPOINT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+plan\s+add(?:\s|$)/iu,
    id: "git-arc.plan-add",
    presentationName: "git_arc_plan_add",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+plan\s+remove(?:\s|$)/iu,
    id: "git-arc.plan-remove",
    presentationName: "git_arc_plan_remove",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+plan\s+adopt(?:\s|$)/iu,
    id: "git-arc.plan-adopt",
    presentationName: "git_arc_plan_adopt",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+plan\s+start(?:\s|$)/iu,
    id: "git-arc.plan-start",
    presentationName: "git_arc_plan_start",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+rescind(?:\s|$)/iu,
    id: "git-arc.rescind",
    presentationName: "git_arc_rescind",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+plan(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.plan,
    presentationName: "git_arc_plan",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+start(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.start,
    presentationName: "git_arc_start",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+wait(?:\s|$)/iu,
    id: "git-arc.wait",
    presentationName: "git_arc_wait",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+continue(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.continue,
    presentationName: "git_arc_continue",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+add(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.add,
    presentationName: "git_arc_add",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+adopt(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.adopt,
    presentationName: "git_arc_adopt",
  }),
  CommandMatcher({
    id: ARC_MATCHER_IDS.mv,
    match: ({ stage }) => {
      const intent = parseGitArcCommand(stage.text.trim());
      if (intent?.action !== "mv") return null;
      const preview = intent.move?.kind === "regex" && !intent.move.confirm;
      return getWorkbenchCommandRendering("git_arc_mv", {
        move: {
          confirm: !preview,
          kind: intent.move?.kind ?? "operands",
        },
      })?.result ?? null;
    },
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+remove(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.remove,
    presentationName: "git_arc_remove",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+release(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.release,
    presentationName: "git_arc_release",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+compare(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.compare,
    presentationName: "git_arc_compare",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+diff(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.diff,
    presentationName: "git_arc_diff",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+propose(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.propose,
    presentationName: "git_arc_propose",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+restore(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.restore,
    presentationName: "git_arc_restore",
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

export function getGitArcMatcherAction(claimedBy: string | null | undefined): GitArcCommandAction | null {
  for (const [action, matcherId] of Object.entries(ARC_MATCHER_IDS) as Array<[GitArcCommandAction, string]>) {
    if (includesMatcher(claimedBy, matcherId)) return action;
  }
  return null;
}

export function parseGitArcCommand(command: string): GitArcCommandIntent | null {
  const tokens = tokenizeCommand(String(command ?? "").trim());
  if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")) return null;
  let cursor = tokens[1] === "git" ? 2 : 1;
  if (tokens[cursor] !== "arc") return null;
  const rootAction = tokens[cursor + 1];
  const nestedPlanAction = rootAction === "plan"
    ? ({ add: "planAdd", adopt: "planAdopt", remove: "planRemove", start: "planStart" } as const)[tokens[cursor + 2] as "add" | "adopt" | "remove" | "start"]
    : undefined;
  const action = (nestedPlanAction ?? rootAction) as GitArcCommandAction | undefined;
  if (!action || !(action in ARC_MATCHER_IDS)) return null;
  cursor += nestedPlanAction ? 3 : 2;

  if (action === "mv") {
    try {
      const move = parseGitArcMoveArguments(tokens.slice(cursor));
      const paths = move.kind === "operands"
        ? move.operands
        : move.kind === "maps"
          ? move.mappings.flatMap(({ destination, source }) => [source, destination])
          : move.roots;
      return { action, intentName: null, move, paths, ref: null };
    } catch {
      return null;
    }
  }

  let intentName: string | null = null;
  let disown = false;
  let proposalId: string | null = null;
  let ref: string | null = null;
  const adoptPaths: string[] = [];
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    if (flag === "--disown") {
      if (action !== "release" || disown) return null;
      disown = true;
      continue;
    }
    const value = tokens[cursor + 1];
    if (!value || (flag !== "--adopt" && flag !== "--proposal" && flag !== "--ref" && flag !== "-m")) return null;
    if (flag === "--ref") {
      if (ref) return null;
      ref = value;
    } else if (flag === "--adopt") {
      if (action !== "plan" && action !== "planStart") return null;
      adoptPaths.push(value);
    } else if (flag === "--proposal") {
      if (proposalId) return null;
      proposalId = value;
    } else if ((action === "plan" || action === "planStart") && intentName === null) {
      intentName = value;
    }
    cursor += 1;
  }
  const paths = tokens[cursor] === "--" ? tokens.slice(cursor + 1) : [];
  if (action === "plan" || action === "planStart") {
    return intentName ? {
      action,
      ...(adoptPaths.length ? { adoptPaths } : {}),
      intentName,
      paths,
      ref: null,
    } : null;
  }
  if (action === "rescind") {
    return proposalId && !ref && !paths.length
      ? { action, intentName: null, paths: [], proposalId, ref: null }
      : null;
  }
  if (proposalId) return null;
  const refRequired = action === "continue" || action === "restore";
  if (refRequired !== Boolean(ref)) return null;
  return { action, ...(action === "release" ? { disown } : {}), intentName: null, paths, ref };
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
  const literalAssignment = unwrapLeadingPowerShellLiteralHereStringAssignment(command);
  const tokens = tokenizeCommand(String(literalAssignment?.command ?? command ?? "").trim());
  if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")) return null;
  let cursor = 1;
  if (tokens[cursor] === "git") cursor += 1;
  if (tokens[cursor] !== "arc" || tokens[cursor + 1] !== "propose") return null;
  cursor += 2;

  let amend = false;
  let description: string | null = null;
  let replacementProposalId: string | null = null;
  let rootId: string | null = null;
  let title: string | null = null;
  const legacyMessages: string[] = [];
  const resolveLiteralValue = (value: string) => (
    literalAssignment && value.toLowerCase() === `$${literalAssignment.variableName.toLowerCase()}`
      ? literalAssignment.value
      : value
  );
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    if (flag === "--amend") {
      if (amend) return null;
      amend = true;
      continue;
    }
    const value = tokens[cursor + 1];
    if (flag === "--replace") {
      if (replacementProposalId || !value) return null;
      replacementProposalId = value;
      cursor += 1;
      continue;
    }
    if (flag === "--root") {
      if (rootId || !value) return null;
      rootId = value;
      cursor += 1;
      continue;
    }
    if (flag === "--title") {
      if (title !== null || !value) return null;
      title = resolveLiteralValue(value);
      cursor += 1;
      continue;
    }
    if (flag === "--description") {
      if (description !== null || !value) return null;
      description = resolveLiteralValue(value);
      cursor += 1;
      continue;
    }
    if (flag !== "-m" || !value || title !== null || description !== null) return null;
    legacyMessages.push(resolveLiteralValue(value));
    cursor += 1;
  }
  const paths = tokens[cursor] === "--" ? tokens.slice(cursor + 1) : [];
  if (legacyMessages.length > 2) return null;
  title ??= legacyMessages[0] ?? "";
  description ??= legacyMessages[1] ?? "";
  if (!amend && !title) return null;
  return {
    amend,
    description,
    paths,
    ...(rootId ? { rootId } : {}),
    title,
  };
}

export { parseGitArcReceipt };

export function parseGitCheckpointDiffOutput(output: string): FileUpdateChange[] {
  const lines = String(output ?? "").split(/\r?\n/u);
  const trailerIndex = lines.findIndex((line) => line === GIT_ARC_DIFF_TRAILER_PREFIX);
  const diff = (trailerIndex < 0 ? lines : lines.slice(0, trailerIndex)).join("\n");
  return parseUnifiedDiffFileChanges(diff).map((change) => ({
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
