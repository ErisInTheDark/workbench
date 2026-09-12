/*
 * Exports:
 * - createGitArcFailureFromError: preserve typed owner/schema rejections with bounded agent diagnostics.
 * - GitArcFailureAction/GitArcFailure/GitArcFailureEnvelope: type rejection identity, facts and HTTP transport.
 * - GitArcFailureSchema/GitArcFailureEnvelopeSchema/parseGitArcFailureEnvelope: validate failures across transport boundaries.
 * - GitArcFailureException/GitArcMissingClaimSetError/GitArcProposalAlreadyCommittedError/createGitArcOperationRejected: preserve typed failures and generic fallback.
 * - describeGitArcFailure/formatGitArcFailureText: share human presentation and agent recovery.
 * - formatGitArcFailureReceipt/parseGitArcFailureReceipt: encode and decode persisted failure facts.
 * - GitArcDriftComparison: complete plan-scoped file counts without patches.
 * - formatGitArcDriftComparison: render comparison rows and cumulative additions/deletions.
 * - describeGitArcDriftRecovery: suggest workflow-neutral drift inspection routes.
 */
import { z } from "zod";
import { escapeGitArcValue, readGitArcValue } from "./git-arc-receipts";
import { describeGitArcRejection, GitArcRejectionError, GitArcRejectionSchema, readGitArcValidationRejection } from "./git-arc-rejections";

const FAILURE_RECEIPT_PREFIX = "Workbench arc failure: ";
const nonEmptyString = z.string().trim().min(1);
const boundedPath = nonEmptyString.max(2_000);
const checkpointSha = nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu);

const GitArcDriftComparisonSchema = z.array(z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  kind: z.enum(["add", "delete", "update"]),
  path: nonEmptyString,
}).strict());

export type GitArcDriftComparison = z.infer<typeof GitArcDriftComparisonSchema>;

const GitArcFailureActionSchema = z.enum([
  "planClaims", "arcClaims", "arcScope", "arcStatus",
  "plan", "planAdd", "planAdopt", "planRemove", "planStart",
  "arcContinue", "arcStart", "arcWait", "arcAdd", "arcAdopt", "arcRemove", "arcRelease", "arcMove",
  "compare", "diff", "proposalCreate", "proposalRescind", "proposalState", "proposalCommit",
  "readDiffArtifact", "restore", "unknown",
]);

const GitArcFailureBaseSchema = z.object({
  action: GitArcFailureActionSchema,
  version: z.literal(1),
  workspace: z.object({
    failedRootIds: z.array(boundedPath).max(20),
    completedRootIds: z.array(boundedPath).max(20),
    stage: z.enum(["preflight", "operation"]),
  }).strict().optional(),
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
    code: z.literal("rejection"),
    rejection: GitArcRejectionSchema,
    diagnostic: nonEmptyString.max(4_000),
  }).strict(),
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
    comparison: GitArcDriftComparisonSchema.nullable().default(null),
    commits: z.array(z.object({
      commit: checkpointSha,
      paths: z.array(boundedPath).min(1).max(20),
      subject: z.string().max(300),
    }).strict()).max(8),
    conflicts: z.array(GitArcConflictSchema).max(8),
    dirtyPaths: z.array(boundedPath).max(20),
    headMovement: z.enum(["fastForward", "incompatible", "same"]),
    planRef: checkpointSha,
    snapshotPaths: z.array(boundedPath).max(20),
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
  error: nonEmptyString,
  gitArcFailure: GitArcFailureSchema,
}).strict().refine(({ error, gitArcFailure }) => gitArcFailure.code === "planDrift" || error.length <= 8_000, {
  path: ["error"],
  message: "Failure message exceeds 8,000 characters.",
});

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

export function createGitArcFailureFromError(action: GitArcFailureAction, error: unknown): GitArcFailure {
  if (error instanceof GitArcFailureException) return error.failure;
  const rejection = error instanceof GitArcRejectionError
    ? error.rejection
    : error instanceof z.ZodError ? readGitArcValidationRejection(error.issues) : null;
  const diagnostic = boundedMessage(error instanceof Error ? error.message : String(error));
  return rejection
    ? { action, code: "rejection", rejection, diagnostic, version: 1 }
    : createGitArcOperationRejected(action, diagnostic);
}

export function formatGitArcDriftComparison(comparison: GitArcDriftComparison) {
  const additions = comparison.reduce((sum, change) => sum + change.additions, 0);
  const deletions = comparison.reduce((sum, change) => sum + change.deletions, 0);
  return [
    `comparison ${comparison.length}`,
    ...comparison.map(({ additions, deletions, binary, kind, path }) => (
      `${kind.slice(0, 1).toUpperCase()}\t+${additions}\t-${deletions}\t${escapeGitArcValue(path)}${binary ? "\tbinary" : ""}`
    )),
    `total +${additions} -${deletions} (${additions + deletions} changed lines)`,
  ];
}

export function describeGitArcDriftRecovery(ref: string) {
  return `Inspect git_arc_diff against ${ref} or rebase planned work on current code.`;
}

export function describeGitArcFailure(failure: GitArcFailure) {
  switch (failure.code) {
    case "rejection":
      return { agentRecovery: null, message: describeGitArcRejection(failure.rejection), userHint: null };
    case "adoptedPathOverlap":
      return {
        agentRecovery: "This is a historical failure receipt. Retry the plan with current Git arc behavior, which supports nested ordinary and adopted scope.",
        message: "Ordinary and adopted plan scopes overlap.",
        userHint: "Retry this plan with current Git arc behavior.",
      };
    case "siblingClaimCollision":
      return isAdoptionAction(failure.action)
        ? {
          agentRecovery: "Do not adopt sibling-owned work. Keep ordinary plan scope and call git_arc_wait to wait and activate it.",
          message: "Another thread owns the selected changes.",
          userHint: "Wait for the owning thread to release its claim.",
        }
        : {
          agentRecovery: `${failure.action === "arcStart" || failure.action === "arcWait" ? "" : "If the intended scope has no inactive plan, publish it with git_plan_claims first. "}Call git_arc_wait to activate the inactive plan once claims clear. Do not republish an existing plan for collisions alone, or adopt, restore, or overwrite sibling-owned work.`,
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
      if (failure.conflicts.length) {
        return {
          agentRecovery: "Call git_arc_wait. Do not republish the plan while sibling claims intersect. After claims clear, waiting rechecks the original baseline and reports any remaining drift.",
          message: "Another thread owns the requested paths. The plan baseline also changed.",
          userHint: "Wait for the owning thread to finish before reviewing the changed baseline.",
        };
      }
      return {
        agentRecovery: describeGitArcDriftRecovery(failure.planRef),
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
          agentRecovery: "Read accepted receipts. Continue the registered lifecycle, or use git_arc_claims with inherit: true and explicit approved scope changes. Changed approval boundaries require a new brief.",
          message: `This Git arc has accepted commits and still owns ${failure.claimedPaths.length} live claim${failure.claimedPaths.length === 1 ? "" : "s"}.`,
          userHint: "Create a new plan for the remaining approved paths.",
        }
        : {
          agentRecovery: "Resolved continuation acquires nothing. Approved follow-up uses git_arc_claims with inherit: true and explicit additions/adoptions. Changed approval boundaries require a new brief.",
          message: "This Git arc is already resolved and owns no live claims.",
          userHint: "Start a new plan for any remaining approved work.",
        };
    case "missingClaimSet":
      return {
        agentRecovery: "Return to Brief mode. Use git_plan_claims once exact paths are known.",
        message: "This Git arc checkpoint does not contain any claimed paths.",
        userHint: "Create a new plan for the intended files.",
      };
    case "proposalAlreadyCommitted":
      return {
        agentRecovery: `Use git_arc_propose with amend: ${JSON.stringify(failure.proposalId)} and freshTitle for content changes, or git_arc_reword for message-only changes. Otherwise omit targets for a separate proposal.`,
        message: `Commit ${failure.proposalTitle} already exists at ${failure.commitSha}.`,
        userHint: "Create a separate proposal, or amend the accepted commit.",
      };
    case "operationRejected":
      return {
        agentRecovery: null,
        message: "The Git arc action could not be completed.",
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
  const lines = [failure.code === "operationRejected" ? failure.message : failure.code === "rejection" ? failure.diagnostic : presentation.message];
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
    if (failure.comparison) lines.push("", ...formatGitArcDriftComparison(failure.comparison));
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
  if (failure.workspace) {
    lines.push(`Failed projects: ${failure.workspace.failedRootIds.join(", ")}`);
    if (failure.workspace.completedRootIds.length) lines.push(`Completed projects: ${failure.workspace.completedRootIds.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatGitArcFailureReceipt(failure: GitArcFailure) {
  const facts = GitArcFailureSchema.parse(failure);
  const lines = [`arc failure ${facts.action} ${facts.code}`];
  const row = (...values: string[]) => lines.push(values.map(escapeGitArcValue).join("\t"));
  const list = (name: string, values: string[]) => {
    lines.push(`${name} ${values.length}`);
    values.forEach((value) => row(value));
  };
  if ("paths" in facts) list("paths", facts.paths);
  if ("ref" in facts) lines.push(`ref ${facts.ref}`);
  if ("message" in facts) lines.push(`message ${escapeGitArcValue(facts.message)}`);
  if (facts.code === "rejection") {
    lines.push(`rejection ${JSON.stringify(facts.rejection)}`, `diagnostic ${escapeGitArcValue(facts.diagnostic)}`);
  }
  if (facts.workspace) lines.push(`workspace ${JSON.stringify(facts.workspace)}`);
  if (facts.code === "adoptedPathOverlap") {
    lines.push(`overlaps ${facts.overlaps.length}`);
    facts.overlaps.forEach(({ adoptedPath, ordinaryPath }) => row(adoptedPath, ordinaryPath));
  }
  if ("conflicts" in facts) {
    lines.push(`conflicts ${facts.conflicts.length}`);
    for (const { owner, overlaps } of facts.conflicts) {
      row(owner.checkpointCommit, owner.harness, owner.intentName, owner.lifecycle, owner.threadId, owner.title, String(overlaps.length));
      overlaps.forEach(({ claimedPath, requestedPath }) => row(claimedPath, requestedPath));
    }
  }
  if (facts.code === "planDrift") {
    lines.push(`plan-ref ${facts.planRef}`, `head ${facts.headMovement}`);
    list("snapshot", facts.snapshotPaths);
    list("dirty", facts.dirtyPaths);
    lines.push(`commits ${facts.commits.length}`);
    for (const commit of facts.commits) {
      row(commit.commit, commit.subject, String(commit.paths.length));
      commit.paths.forEach((path) => row(path));
    }
    if (facts.comparison) lines.push(...formatGitArcDriftComparison(facts.comparison));
  }
  if (facts.code === "acceptedProposals") {
    list("claimed", facts.claimedPaths);
    lines.push(`accepted ${facts.proposals.length}`);
    facts.proposals.forEach(({ proposalId, commitSha, title }) => row(proposalId, commitSha, ...(title === undefined ? [] : [title])));
  }
  if (facts.code === "proposalAlreadyCommitted") {
    lines.push("committed");
    row(facts.proposalId, facts.commitSha, facts.proposalTitle);
  }
  lines.push("end failure");
  const recovery = describeGitArcFailure(facts).agentRecovery;
  if (recovery) lines.push(recovery);
  return lines.join("\n");
}

function parseTextFailure(output: string) {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^arc failure \S+ \S+$/u.test(line));
  if (start < 0) return null;
  const [, , action, code] = lines[start]!.split(" ");
  const result: Record<string, string | number | object | undefined> = { action, code, version: 1 };
  let index = start + 1;
  const count = (value: string) => {
    if (!/^\d+$/u.test(value) || Number(value) > lines.length) throw new Error("Invalid failure section count.");
    return Number(value);
  };
  const row = (min: number, max = min) => {
    if (index >= lines.length) throw new Error("Truncated failure facts.");
    const values = lines[index++]!.split("\t").map(readGitArcValue);
    if (values.length < min || values.length > max) throw new Error("Invalid failure row.");
    return values;
  };
  const list = (length: number) => Array.from({ length }, () => row(1)[0]!);
  const seen = new Set<string>();
  while (index < lines.length) {
    const line = lines[index++]!;
    if (line === "end failure") return GitArcFailureSchema.parse(result);
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (seen.has(key)) throw new Error("Duplicate failure section.");
    seen.add(key);
    if (["paths", "snapshot", "dirty", "claimed"].includes(key)) {
      result[key === "snapshot" ? "snapshotPaths" : key === "dirty" ? "dirtyPaths" : key === "claimed" ? "claimedPaths" : key] = list(count(value));
    } else if (key === "rejection" || key === "workspace") {
      result[key] = JSON.parse(value);
    } else if (["ref", "message", "diagnostic", "plan-ref", "head"].includes(key)) {
      result[key === "plan-ref" ? "planRef" : key === "head" ? "headMovement" : key] = readGitArcValue(value);
    } else if (key === "overlaps") {
      result.overlaps = Array.from({ length: count(value) }, () => {
        const [adoptedPath, ordinaryPath] = row(2);
        return { adoptedPath, ordinaryPath };
      });
    } else if (key === "conflicts") {
      result.conflicts = Array.from({ length: count(value) }, () => {
        const [checkpointCommit, harness, intentName, lifecycle, threadId, title, length] = row(7);
        const overlaps = Array.from({ length: count(length!) }, () => {
          const [claimedPath, requestedPath] = row(2);
          return { claimedPath, requestedPath };
        });
        return { owner: { checkpointCommit, harness, intentName, lifecycle, threadId, title }, overlaps };
      });
    } else if (key === "comparison") {
      const comparison = Array.from({ length: count(value) }, () => {
        const [kind, additions, deletions, path, binary] = row(4, 5);
        if (!/^\+\d+$/u.test(additions!) || !/^-\d+$/u.test(deletions!) || (binary !== undefined && binary !== "binary")) {
          throw new Error("Invalid comparison row.");
        }
        return {
          kind: kind === "A" ? "add" : kind === "D" ? "delete" : kind === "U" ? "update" : kind,
          additions: Number(additions!.slice(1)), deletions: Number(deletions!.slice(1)),
          binary: binary === "binary", path,
        };
      });
      const parsed = GitArcDriftComparisonSchema.parse(comparison);
      if (lines[index++] !== formatGitArcDriftComparison(parsed).at(-1)) throw new Error("Invalid comparison totals.");
      result.comparison = parsed;
    } else if (key === "commits") {
      result.commits = Array.from({ length: count(value) }, () => {
        const [commit, subject, length] = row(3);
        return { commit, subject, paths: list(count(length!)) };
      });
    } else if (key === "accepted") {
      result.proposals = Array.from({ length: count(value) }, () => {
        const [proposalId, commitSha, title] = row(2, 3);
        return { proposalId, commitSha, ...(title === undefined ? {} : { title }) };
      });
    } else if (key === "committed") {
      const [proposalId, commitSha, proposalTitle] = row(3);
      Object.assign(result, { proposalId, commitSha, proposalTitle });
    } else throw new Error("Unknown failure section.");
  }
  return null;
}

export function parseGitArcFailureReceipt(output: string) {
  const line = String(output ?? "").split(/\r?\n/u).find((candidate) => candidate.startsWith(FAILURE_RECEIPT_PREFIX));
  try {
    if (!line) {
      const receipt = parseTextFailure(output);
      if (receipt) return receipt;
      // The SDK validates before dispatch and serializes Zod issues, including custom params.
      const wrapper = /(?:^|\n)(?:MCP error -32602: )?Input validation error: Invalid arguments for tool [\w.-]+: ([\s\S]+)$/u.exec(output);
      if (!wrapper) return null;
      const rejection = readGitArcValidationRejection(JSON.parse(wrapper[1]!));
      return rejection ? GitArcFailureSchema.parse({
        action: "unknown", code: "rejection", rejection, diagnostic: boundedMessage(output), version: 1,
      }) : null;
    }
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
