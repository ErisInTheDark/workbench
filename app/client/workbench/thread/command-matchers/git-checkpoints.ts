/*
 * Exports:
 * - GIT_CHECKPOINT_COMMAND_MATCHERS: named arc command presentation.
 * - getGitArcMatcherAction/isGitCheckpointCompareMatcherClaim/isGitCheckpointDiffMatcherClaim/isGitCheckpointCommitMatcherClaim: specialised arc routes.
 * - parseGitArcCommand/GitArcCommandIntent/GitArcCommandAction: canonical arc command intent.
 * - parseGitArcReceipt: persisted successful arc facts.
 * - parseGitCheckpointCompareOutput: per-file change counts.
 * - parseGitCheckpointProposalId: proposal identity from output.
 * - parseGitCheckpointCommitCommand/GitCheckpointCommitCommandIntent: proposal-card command intent.
 * - parseGitCheckpointDiffArtifactId/parseGitCheckpointDiffOutput: legacy and inline diff content without trailers.
 */
import type { FileUpdateChange } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  parseGitArcReceipt,
  readGitArcValue,
} from "workbench-shared/workbench/git/git-arc-receipts";
import { GIT_ARC_DIFF_TRAILER_PREFIX } from "workbench-shared/workbench/git/git-arc-diff-pages";
import { parseGitClaimArguments } from "workbench-shared/workbench/git/git-claim-arguments";
import { parseUnifiedDiffFileChanges } from "workbench-shared/workbench/thread/unified-diff";
import { CommandMatcher } from "./core";
import { tokenizeCommand } from "./helpers";
import { unwrapLeadingPowerShellLiteralHereStringAssignment } from "./shells";
import type { CommandMatcherDefinition } from "./types";
import {
  getUnknownGitArcCommandRoute,
  getWorkbenchCommandRendering,
  isGitArcEditStep,
  type GitArcEditStep,
  type GitCheckpointCommitCommandIntent,
  type WorkbenchCommandPresentationName,
  type WorkbenchGitArcOperation,
} from "./workbench-command-rendering";

export type { GitCheckpointCommitCommandIntent } from "./workbench-command-rendering";

export type GitArcCommandAction = WorkbenchGitArcOperation["action"];

const ARC_MATCHER_IDS = {
  adopt: "git-arc.adopt",
  claims: "git-arc.claims",
  scope: "git-arc.scope",
  status: "git-arc.status",
  compare: "git-arc.compare",
  continue: "git-arc.continue",
  diff: "git-arc.diff",
  edit: "git-arc.edit",
  plan: "git-arc.plan",
  propose: "git-arc.propose",
  release: "git-arc.release",
  restore: "git-arc.restore",
  start: "git-arc.start",
  stack: "git-arc.stack",
  stash: "git-arc.stash",
  unstack: "git-arc.unstack",
  unstash: "git-arc.unstash",
  planStart: "git-arc.plan-start",
  rescind: "git-arc.rescind",
  unknown: "git-arc.unknown",
} as const satisfies Record<GitArcCommandAction, string>;
const CHECKPOINT_DIFF_ARTIFACT_PATTERN = /^Full diff artifact:\s*([a-f0-9]{64})\s*$/im;
const CHECKPOINT_PROPOSAL_PATTERN = /^Workbench arc proposal:\s*([A-Za-z0-9._-]+)\s*$/im;
const CHECKPOINT_COMPARE_LINE_PATTERN = /^([ADMU])\t\+(\d+)\t-(\d+)\t(.+)$/u;

export interface GitArcCommandIntent {
  action: GitArcCommandAction;
  adoptPaths?: string[];
  removePaths?: string[];
  disown?: boolean;
  editStep?: GitArcEditStep;
  intentName: string | null;
  layerTitle?: string;
  paths: string[];
  proposalId?: string | null;
  source?: { name?: string; threadId?: string };
  toSubagent?: string;
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
  createMatcher({ commandPattern: /^wb(?:\.cmd)?\s+git\s+plan\s+claims(?:\s|$)/iu, id: ARC_MATCHER_IDS.plan, presentationName: "git_plan_claims" }),
  createMatcher({ commandPattern: /^wb(?:\.cmd)?\s+git\s+plan\s+start(?:\s|$)/iu, id: ARC_MATCHER_IDS.planStart, presentationName: "git_plan_start" }),
  createMatcher({ commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+claims(?:\s|$)/iu, id: ARC_MATCHER_IDS.claims, presentationName: "git_arc_claims" }),
  createMatcher({ commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+scope(?:\s|$)/iu, id: ARC_MATCHER_IDS.scope, presentationName: "git_arc_scope" }),
  createMatcher({ commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+status(?:\s|$)/iu, id: ARC_MATCHER_IDS.status, presentationName: "git_arc_status" }),
  createMatcher({ commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+reword(?:\s|$)/iu, id: ARC_MATCHER_IDS.propose, presentationName: "git_arc_reword" }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+rescind(?:\s|$)/iu,
    id: "git-arc.rescind",
    presentationName: "git_arc_rescind",
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
  CommandMatcher({
    id: ARC_MATCHER_IDS.edit,
    match: ({ stage }) => {
      const intent = parseGitArcCommand(stage.text.trim());
      if (intent?.action !== "edit" || !intent.editStep) return null;
      return getWorkbenchCommandRendering("git_arc_edit", { editStep: intent.editStep })?.result ?? null;
    },
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
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+adopt(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.adopt,
    presentationName: "git_arc_adopt",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+stash(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.stash,
    presentationName: "git_arc_stash",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+unstash(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.unstash,
    presentationName: "git_arc_unstash",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+stack(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.stack,
    presentationName: "git_arc_stack",
  }),
  createMatcher({
    commandPattern: /^wb(?:\.cmd)?\s+git\s+arc\s+unstack(?:\s|$)/iu,
    id: ARC_MATCHER_IDS.unstack,
    presentationName: "git_arc_unstack",
  }),
  CommandMatcher({
    id: ARC_MATCHER_IDS.unknown,
    match: ({ stage }) => /^wb(?:\.cmd)?\s+git\s+(?:arc|plan)(?:\s|$)/iu.test(stage.text.trim())
      ? getUnknownGitArcCommandRoute().rendering.result
      : null,
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
  const planning = tokens[cursor] === "plan";
  if ((planning && ["claims", "start"].includes(tokens[cursor + 1] ?? "")) || (tokens[cursor] === "arc" && tokens[cursor + 1] === "claims")) {
    try {
      const claims = parseGitClaimArguments(tokens.slice(cursor + 2), planning);
      return {
        action: planning ? tokens[cursor + 1] === "start" ? "planStart" : "plan" : "claims",
        paths: claims.addPaths, removePaths: claims.removePaths, adoptPaths: claims.adoptPaths,
        intentName: claims.intentName ?? null, ref: null,
      };
    } catch {
      return null;
    }
  }
  if (tokens[cursor] !== "arc") return null;
  const action = tokens[cursor + 1] as GitArcCommandAction | undefined;
  if (!action || !(action in ARC_MATCHER_IDS) || action === "plan" || action === "planStart" || action === "unknown") return null;
  cursor += 2;

  if (action === "edit") {
    const step = tokens[cursor];
    return isGitArcEditStep(step) ? { action, editStep: step, intentName: null, paths: [], ref: null } : null;
  }
  if (action === "stack") {
    const [flag, value, ...extra] = tokens.slice(cursor);
    return flag === "--title" && value && !extra.length
      ? { action, intentName: null, layerTitle: value, paths: [], ref: null }
      : null;
  }
  if (action === "unstack") {
    return cursor === tokens.length ? { action, intentName: null, paths: [], ref: null } : null;
  }
  if (action === "adopt") {
    const [flag, value, ...extra] = tokens.slice(cursor);
    if (extra.length || !value || (flag !== "--name" && flag !== "--thread")) return null;
    return {
      action, intentName: null, paths: [], ref: null,
      source: flag === "--name" ? { name: value } : { threadId: value },
    };
  }

  let disown = false;
  let toSubagent: string | null = null;
  let proposalId: string | null = null;
  let ref: string | null = null;
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    if (flag === "--disown") {
      if (action !== "release" || disown) return null;
      disown = true;
      continue;
    }
    const value = tokens[cursor + 1];
    if (!value || (flag !== "--proposal" && flag !== "--ref" && flag !== "--to-subagent")) return null;
    if (flag === "--ref") {
      if (ref) return null;
      ref = value;
    } else if (flag === "--to-subagent") {
      if (action !== "release" || toSubagent) return null;
      toSubagent = value;
    } else if (flag === "--proposal") {
      if (proposalId) return null;
      proposalId = value;
    }
    cursor += 1;
  }
  const paths = tokens[cursor] === "--" ? tokens.slice(cursor + 1) : [];
  if (action === "rescind") {
    return proposalId && !ref && !paths.length
      ? { action, intentName: null, paths: [], proposalId, ref: null }
      : null;
  }
  if (proposalId) return null;
  if (action === "release" && (Boolean(toSubagent) !== Boolean(paths.length) || toSubagent && disown)) return null;
  if ((action === "stash" || action === "unstash") && (ref || paths.length || disown)) return null;
  if (action === "restore" && !ref) return null;
  return { action, ...(action === "release" ? { disown, ...(toSubagent ? { toSubagent } : {}) } : {}), intentName: null, paths, ref };
}

export function parseGitCheckpointCompareOutput(output: string) {
  return String(output ?? "").split(/\r?\n/u).flatMap((line) => {
    const match = CHECKPOINT_COMPARE_LINE_PATTERN.exec(line);
    if (!match) return [];
    let path: string;
    try {
      path = readGitArcValue(match[4]!);
    } catch {
      return [];
    }
    return [{
      additions: Number(match[2]),
      deletions: Number(match[3]),
      path,
      status: match[1] as "A" | "D" | "M" | "U",
    }];
  });
}

export function parseGitCheckpointProposalId(output: string) {
  return parseGitArcReceipt(output)?.proposalId ?? CHECKPOINT_PROPOSAL_PATTERN.exec(String(output ?? ""))?.[1] ?? null;
}

export function parseGitCheckpointCommitCommand(command: string): GitCheckpointCommitCommandIntent | null {
  const literalAssignment = unwrapLeadingPowerShellLiteralHereStringAssignment(command);
  const tokens = tokenizeCommand(String(literalAssignment?.command ?? command ?? "").trim());
  if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")) return null;
  let cursor = 1;
  if (tokens[cursor] === "git") cursor += 1;
  if (tokens[cursor] !== "arc" || !["propose", "reword"].includes(tokens[cursor + 1] ?? "")) return null;
  const reword = tokens[cursor + 1] === "reword";
  cursor += 2;

  let mode: GitCheckpointCommitCommandIntent["mode"] = "commit";
  let description: string | null = null;
  let freshDescription: string | null = null;
  let freshTitle: string | null = null;
  let replacementProposalId: string | null = null;
  let rootId: string | null = null;
  let title: string | null = null;
  const resolveLiteralValue = (value: string) => (
    literalAssignment && value.toLowerCase() === `$${literalAssignment.variableName.toLowerCase()}`
      ? literalAssignment.value
      : value
  );
  for (; cursor < tokens.length && tokens[cursor] !== "--"; cursor += 1) {
    const flag = tokens[cursor];
    if (flag === "--amend") {
      if (mode !== "commit") return null;
      if (tokens[cursor + 1] && !tokens[cursor + 1]!.startsWith("-")) {
        replacementProposalId = tokens[cursor + 1]!;
        mode = null;
        cursor += 1;
      } else {
        mode = "amend";
      }
      continue;
    }
    const value = tokens[cursor + 1];
    if (reword && flag === "--proposal") {
      if (replacementProposalId || !value) return null;
      replacementProposalId = value;
      mode = null;
      cursor += 1;
      continue;
    }
    if (flag === "--replace") {
      if (replacementProposalId || !value) return null;
      replacementProposalId = value;
      mode = null;
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
    if (flag === "--fresh-description") {
      if (freshDescription !== null || value === undefined) return null;
      freshDescription = resolveLiteralValue(value);
      cursor += 1;
      continue;
    }
    if (flag === "--fresh-title") {
      if (freshTitle !== null || !value) return null;
      freshTitle = resolveLiteralValue(value);
      cursor += 1;
      continue;
    }
    return null;
  }
  const paths = tokens[cursor] === "--" ? tokens.slice(cursor + 1) : [];
  title ??= "";
  description ??= "";
  if (mode === "commit" && !title) return null;
  return {
    description,
    ...(freshDescription !== null ? { freshDescription } : {}),
    ...(freshTitle ? { freshTitle } : {}),
    mode,
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
