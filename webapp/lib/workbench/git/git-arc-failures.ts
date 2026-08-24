/*
 * Exports:
 * - GitArcFailureAction/GitArcFailure/GitArcFailureEnvelope: describe typed Git arc rejection identity, structured facts, and HTTP transport. Keywords: git, arc, failure, contract, transport.
 * - GitArcFailureSchema/GitArcFailureEnvelopeSchema/parseGitArcFailureEnvelope: validate failure payloads at server, CLI, transcript, and browser boundaries. Keywords: git, arc, failure, Zod, boundary.
 * - GitArcFailureException/GitArcMissingClaimSetError/GitArcProposalAlreadyCommittedError/createGitArcOperationRejected: preserve typed operation failures and explicit generic fallback. Keywords: git, arc, error, exception, fallback.
 * - describeGitArcFailure/formatGitArcFailureText: share concise human and agent recovery wording from the typed failure. Keywords: git, arc, failure, presentation, recovery.
 * - formatGitArcFailureReceipt/parseGitArcFailureReceipt: encode and decode stable persisted failure metadata. Keywords: git, arc, failure, receipt, transcript.
 */
import { z } from "zod";

const FAILURE_RECEIPT_PREFIX = "Workbench arc failure: ";
const nonEmptyString = z.string().trim().min(1);
const boundedPath = nonEmptyString.max(2_000);
const checkpointSha = nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu);

const GitArcFailureActionSchema = z.enum([
  "plan", "planAdd", "planAdopt", "planRemove", "planStart",
  "arcContinue", "arcStart", "arcAdd", "arcAdopt", "arcRemove", "arcMove",
  "compare", "diff", "proposalCreate", "proposalRescind", "proposalState", "proposalCommit",
  "readDiffArtifact", "restore", "unknown",
]);

const GitArcFailureBaseSchema = z.object({
  action: GitArcFailureActionSchema,
  version: z.literal(1),
});

const GitArcOverlapSchema = z.object({
  claimedPath: boundedPath,
  requestedPath: boundedPath,
}).strict();

const GitArcConflictOwnerSchema = z.object({
  checkpointCommit: checkpointSha,
  harness: nonEmptyString.max(80),
  intentName: z.string().max(200),
  lifecycle: z.string().max(100),
  threadId: nonEmptyString.max(200),
  title: z.string().max(200),
}).strict();

const GitArcConflictSchema = z.object({
  overlaps: z.array(GitArcOverlapSchema).min(1).max(20),
  owner: GitArcConflictOwnerSchema,
}).strict();

export const GitArcFailureSchema = z.discriminatedUnion("code", [
  GitArcFailureBaseSchema.extend({
    code: z.literal("adoptedPathOverlap"),
    overlaps: z.array(z.object({
      adoptedPath: boundedPath,
      ordinaryPath: boundedPath,
    }).strict()).min(1).max(20),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("siblingClaimCollision"),
    conflicts: z.array(GitArcConflictSchema).min(1).max(8),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("dirtyPaths"),
    paths: z.array(boundedPath).min(1).max(20),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("ignoredPaths"),
    paths: z.array(boundedPath).min(1).max(20),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("planDrift"),
    commits: z.array(z.object({
      commit: checkpointSha,
      paths: z.array(boundedPath).min(1).max(20),
      subject: z.string().max(300),
    }).strict()).max(8),
    conflicts: z.array(GitArcConflictSchema).max(8),
    dirtyPaths: z.array(boundedPath).max(20),
    headMovement: z.enum(["fastForward", "incompatible", "same"]),
    planRef: checkpointSha,
    snapshotPaths: z.array(boundedPath).min(1).max(20),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("missingArcRef"),
    ref: checkpointSha,
  }).strict(),
  GitArcFailureBaseSchema.extend({
    claimedPaths: z.array(boundedPath).max(20),
    code: z.literal("acceptedProposals"),
    proposals: z.array(z.object({
      commitSha: checkpointSha,
      proposalId: nonEmptyString.max(200),
      title: z.string().max(300).optional(),
    }).strict()).min(1).max(20),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("missingClaimSet"),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("proposalAlreadyCommitted"),
    commitSha: checkpointSha,
    proposalId: nonEmptyString.max(200),
    proposalTitle: nonEmptyString.max(300),
  }).strict(),
  GitArcFailureBaseSchema.extend({
    code: z.literal("operationRejected"),
    message: nonEmptyString.max(4_000),
  }).strict(),
]);

export const GitArcFailureEnvelopeSchema = z.object({
  error: nonEmptyString.max(8_000),
  gitArcFailure: GitArcFailureSchema,
}).strict();

export type GitArcFailureAction = z.infer<typeof GitArcFailureActionSchema>;
export type GitArcFailure = z.infer<typeof GitArcFailureSchema>;
export type GitArcFailureEnvelope = z.infer<typeof GitArcFailureEnvelopeSchema>;

export class GitArcFailureException extends Error {
  constructor(readonly failure: GitArcFailure) {
    super(formatGitArcFailureText(failure));
    this.name = "GitArcFailureException";
  }
}

export class GitArcMissingClaimSetError extends Error {
  constructor() {
    super("This Git arc checkpoint does not contain any claimed paths.");
    this.name = "GitArcMissingClaimSetError";
  }
}

export class GitArcProposalAlreadyCommittedError extends Error {
  constructor(
    readonly commitSha: string,
    readonly proposalId: string,
    readonly proposalTitle: string,
  ) {
    super(`Commit ${proposalTitle} already exists at ${commitSha}.`);
    this.name = "GitArcProposalAlreadyCommittedError";
  }
}

function boundedMessage(value: string) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 4_000)
    || "The Git arc operation was rejected.";
}

export function createGitArcOperationRejected(action: GitArcFailureAction, message: string): GitArcFailure {
  return {
    action,
    code: "operationRejected",
    message: boundedMessage(message),
    version: 1,
  };
}

function isAdoptionAction(action: GitArcFailureAction) {
  return action === "plan" || action === "planAdopt" || action === "planStart" || action === "arcAdopt";
}

function isPlanningAction(action: GitArcFailureAction) {
  return action === "plan" || action === "planAdd" || action === "planAdopt" || action === "planStart";
}

export function describeGitArcFailure(failure: GitArcFailure) {
  switch (failure.code) {
    case "adoptedPathOverlap":
      return {
        agentRecovery: "This is a historical failure receipt. Retry the plan with current Git arc behavior, which supports nested ordinary and adopted scope.",
        message: "Ordinary and adopted plan scopes overlap.",
        userHint: "Retry this plan with current Git arc behavior.",
      };
    case "siblingClaimCollision":
      return isAdoptionAction(failure.action)
        ? {
          agentRecovery: "Do not adopt sibling-owned work. Keep it in ordinary plan scope and wait for the owning thread to release its claim.",
          message: "Another thread owns the selected changes.",
          userHint: "Wait for the owning thread to release its claim.",
        }
        : {
          agentRecovery: "Wait for the sibling claims to be released. Do not adopt, restore, or overwrite sibling-owned work.",
          message: "Another thread owns the requested path.",
          userHint: "Wait for the owning thread to release its claim.",
        };
    case "dirtyPaths":
      return {
        agentRecovery: "Adopt these paths only when the changes are intentional, unclaimed, and owned by this thread's approved work.",
        message: failure.action === "plan"
          ? "Cannot plan against unclaimed workspace dirt."
          : "Cannot claim unclaimed workspace dirt.",
        userHint: "Adopt only intentional changes that this thread should own.",
      };
    case "ignoredPaths": {
      const multiple = failure.paths.length !== 1;
      return {
        agentRecovery: "Remove the ignore rule or choose a path Git tracks before retrying.",
        message: `Git ignores the selected ${multiple ? "files" : "file"}.`,
        userHint: `Remove the ignore ${multiple ? "rules" : "rule"} or choose ${multiple ? "files" : "a file"} Git tracks.`,
      };
    }
    case "planDrift":
      return {
        agentRecovery: `Call mcp__wb__git_arc_diff with ${JSON.stringify({ paths: failure.snapshotPaths, ref: failure.planRef })}. If the approved plan is unchanged, follow the planned-path drift workflow with mcp__wb__git_arc_plan_start.`,
        message: "The plan baseline changed.",
        userHint: "Inspect the changed plan paths. Revise the plan only if the approved work changed.",
      };
    case "missingArcRef":
      return {
        agentRecovery: null,
        message: `There is no git arc by the \`${failure.ref}\` ref.`,
        userHint: null,
      };
    case "acceptedProposals":
      return failure.claimedPaths.length
        ? {
          agentRecovery: "Accepted proposals changed this arc's baseline. If the approved plan is unchanged, call mcp__wb__git_arc_plan_start with the explicit next paths. If the plan changed, return to Brief mode and create a new Git plan.",
          message: `This Git arc has accepted commits and still owns ${failure.claimedPaths.length} live claim${failure.claimedPaths.length === 1 ? "" : "s"}.`,
          userHint: "Create a new plan for the remaining approved paths.",
        }
        : {
          agentRecovery: "This Git arc is resolved. If approved work remains unchanged, call mcp__wb__git_arc_plan_start with the explicit next paths. If the plan changed, return to Brief mode and create a new Git plan.",
          message: "This Git arc is already resolved and owns no live claims.",
          userHint: "Start a new plan for any remaining approved work.",
        };
    case "missingClaimSet":
      return {
        agentRecovery: "Return to Brief mode. Create a new plan with mcp__wb__git_arc_plan after the exact approved paths are known.",
        message: "This Git arc checkpoint does not contain any claimed paths.",
        userHint: "Create a new plan for the intended files.",
      };
    case "proposalAlreadyCommitted":
      return {
        agentRecovery: `Call mcp__wb__git_arc_propose with ${JSON.stringify({ amend: true, amendProposalId: failure.proposalId })} to amend this commit. Otherwise create a separate proposal without replaceProposalId or amendProposalId.`,
        message: `Commit ${failure.proposalTitle} already exists at ${failure.commitSha}.`,
        userHint: "Create a separate proposal, or amend the accepted commit.",
      };
    case "operationRejected":
      return {
        agentRecovery: null,
        message: failure.message,
        userHint: null,
      };
  }
}

function appendConflictLines(lines: string[], failure: Extract<GitArcFailure, { code: "siblingClaimCollision" | "planDrift" }>) {
  failure.conflicts.forEach(({ overlaps, owner }) => {
    lines.push(`- ${owner.harness}/${owner.threadId} ${owner.title || owner.intentName} [${owner.lifecycle}] (${owner.checkpointCommit.slice(0, 8)})`);
    overlaps.forEach(({ claimedPath, requestedPath }) => lines.push(`  - claims ${claimedPath} through requested path ${requestedPath}`));
  });
}

export function formatGitArcFailureText(failure: GitArcFailure) {
  const presentation = describeGitArcFailure(failure);
  const lines = [presentation.message];
  if (failure.code === "adoptedPathOverlap") {
    failure.overlaps.forEach(({ adoptedPath, ordinaryPath }) => lines.push(`- adopted ${adoptedPath} overlaps ordinary ${ordinaryPath}`));
  } else if (failure.code === "siblingClaimCollision") {
    lines.push("", "Conflicting threads:");
    appendConflictLines(lines, failure);
  } else if (failure.code === "dirtyPaths") {
    failure.paths.forEach((path) => lines.push(`- ${path}`));
  } else if (failure.code === "ignoredPaths") {
    failure.paths.forEach((path) => lines.push(`- ${isPlanningAction(failure.action) ? "failed to plan ignored file" : "failed to claim ignored file"} ${path}`));
  } else if (failure.code === "planDrift") {
    if (failure.commits.length) {
      lines.push("", "New commits affecting the plan:");
      failure.commits.forEach(({ commit, paths, subject }) => {
        lines.push(`- ${commit.slice(0, 8)} ${subject || "(no subject)"}`);
        paths.forEach((path) => lines.push(`  - ${path}`));
      });
    }
    if (failure.conflicts.length) {
      lines.push("", "Conflicting threads:");
      appendConflictLines(lines, failure);
    }
    if (failure.dirtyPaths.length) {
      lines.push("", "Dirty unclaimed paths:", ...failure.dirtyPaths.map((path) => `- ${path}`));
    }
  } else if (failure.code === "acceptedProposals") {
    lines.push("", "Accepted commit proposals:");
    failure.proposals.forEach(({ commitSha, title }) => lines.push(`- ${title || "Accepted commit"} (${commitSha})`));
    if (failure.claimedPaths.length) {
      lines.push("", "Remaining claimed paths:", ...failure.claimedPaths.map((path) => `- ${path}`));
    }
  }
  if (presentation.agentRecovery) lines.push("", presentation.agentRecovery);
  return lines.join("\n");
}

export function formatGitArcFailureReceipt(failure: GitArcFailure) {
  return `${FAILURE_RECEIPT_PREFIX}${JSON.stringify(GitArcFailureSchema.parse(failure))}`;
}

export function parseGitArcFailureReceipt(output: string) {
  const line = String(output ?? "").split(/\r?\n/u).find((candidate) => candidate.startsWith(FAILURE_RECEIPT_PREFIX));
  if (!line) return null;
  try {
    const parsed = GitArcFailureSchema.safeParse(JSON.parse(line.slice(FAILURE_RECEIPT_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseGitArcFailureEnvelope(
  value: string | unknown,
  onRejectedFailure?: (error: z.ZodError) => void,
) {
  try {
    const parsedValue = typeof value === "string" ? JSON.parse(value) as unknown : value;
    const parsed = GitArcFailureEnvelopeSchema.safeParse(parsedValue);
    if (
      !parsed.success
      && parsedValue !== null
      && typeof parsedValue === "object"
      && "gitArcFailure" in parsedValue
    ) {
      onRejectedFailure?.(parsed.error);
    }
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
