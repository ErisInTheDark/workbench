/*
 * Exports:
 * - GitArcClaimRootSchema: root-qualified literal claim edits.
 * - GitArcClaimsSchema: inherited active scope edits.
 * - GitArcAdoptionSourceSchema: exclusive admitted-thread or owned-child source.
 * - GitArcPlanClaimsSchema: replacement or inherited planning scope.
 * - GitArcRootPathsSchema/GitArcRootPaths and GitArcPlanRootSchema/GitArcPlanRoot: root-qualified path selections.
 * - GitArcMemberRefSchema/GitArcMemberRef and GitArcInspectionMemberRefSchema/GitArcInspectionMemberRef: lifecycle and inspection refs.
 * - GitArcMoveMappingSchema/GitArcMoveRequestSchema: bounded explicit and regex moves.
 * - GitArcMoveMapping/GitArcMoveRequest: validated move requests.
 * - GitCheckpointRequestSchema/GitCheckpointRequest: stateless checkpoint requests.
 * - GitCheckpointFileChangeSchema/GitCheckpointFileChange: per-file inspection changes.
 * - GitCheckpointCompareResultSchema/GitCheckpointCompareResult: local and workspace inspection results.
 * - GitArcStashResultSchema/GitArcStashResult: browser-safe stash and unstash lifecycle result.
 * - GitArcStackResultSchema/GitArcStackResult: sealed or reopened stack layer receipt.
 * - GitArcClaimViewSchema/GitArcClaimView/GitArcClaimViewResultSchema/GitArcClaimViewResult: per-repository build view tree, held owners and mirror counts.
 * - GitCheckpointProposalSchema/GitCheckpointProposal: durable proposal presentation.
 * - GitArcProposalCommitEntry: one proposal's commit choices inside a batched acceptance.
 * - GitArcProposalCommitManyResultSchema/GitArcProposalCommitManyResult: landed proposals and the first failure of a batch.
 * - GitArcProposalSummarySchema/GitArcProposalSummary/GitArcProposalSummariesSchema/GitArcProposalSummaries: bulk diff-free proposal commit facts.
 */
import { z } from "zod";
import { ProviderKeySchema } from "../provider/provider-key.ts";
import { GitArcFailureSchema } from "./git-arc-failures";
import { GitArcStackedProposalSchema } from "./git-arc-receipts";
import { gitArcRejectionIssue } from "./git-arc-rejections";
import { GitArcStatusFullSchema } from "./git-arc-status";
import { GitCheckpointFileChangeSchema } from "./git-checkpoint-file-change.ts";

export { GitCheckpointFileChangeSchema, type GitCheckpointFileChange } from "./git-checkpoint-file-change.ts";

const nonEmptyString = z.string().trim().min(1);
const checkpointSha = nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu);
const checkpointPaths = z.array(nonEmptyString).min(1);
const optionalCheckpointPaths = z.array(nonEmptyString);
const rootId = nonEmptyString;

export const GitArcAdoptionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: nonEmptyString }).strict(),
  z.object({ kind: z.literal("subagent"), name: nonEmptyString }).strict(),
]);

const claimPaths = {
  addPaths: optionalCheckpointPaths.default([]),
  removePaths: optionalCheckpointPaths.default([]),
  adoptPaths: optionalCheckpointPaths.default([]),
};
export const GitArcClaimRootSchema = z.object({ ...claimPaths, rootId }).strict();
const claimChanges = {
  ...claimPaths,
  roots: z.array(GitArcClaimRootSchema).default([]),
};
export const GitArcClaimsSchema = z.object({ ...claimChanges, inherit: z.literal(true) }).strict();
export const GitArcPlanClaimsSchema = z.object({
  ...claimChanges,
  inherit: z.boolean().default(false),
  intentName: nonEmptyString.optional(),
  intentDescription: z.string().optional(),
}).strict().superRefine((input, context) => {
  if (!input.inherit && !input.intentName) {
    context.addIssue(gitArcRejectionIssue({ reason: "missingPlanName" }, "An initial or replacement plan requires intentName.", ["intentName"]));
  }
  if (!input.inherit && (input.removePaths.length || input.roots.some((root) => root.removePaths.length))) {
    context.addIssue(gitArcRejectionIssue({ reason: "inheritanceRequired" }, "Removing planned entries requires inheritance.", ["inherit"]));
  }
});

export const GitArcRootPathsSchema = z.object({
  paths: optionalCheckpointPaths.default([]),
  rootId,
}).strict();

export const GitArcPlanRootSchema = GitArcRootPathsSchema.extend({
  adoptPaths: optionalCheckpointPaths.default([]),
}).strict();

export const GitArcMemberRefSchema = z.object({
  ref: checkpointSha,
  rootId,
}).strict();

export const GitArcInspectionMemberRefSchema = z.object({
  ref: nonEmptyString,
  rootId,
}).strict();

export type GitArcRootPaths = z.infer<typeof GitArcRootPathsSchema>;
export type GitArcPlanRoot = z.infer<typeof GitArcPlanRootSchema>;
export type GitArcMemberRef = z.infer<typeof GitArcMemberRefSchema>;
export type GitArcInspectionMemberRef = z.infer<typeof GitArcInspectionMemberRefSchema>;

export const GitArcMoveMappingSchema = z.object({
  destination: nonEmptyString,
  source: nonEmptyString,
});

export const GitArcMoveRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operands"), operands: z.array(nonEmptyString).min(2) }),
  z.object({ kind: z.literal("maps"), mappings: z.array(GitArcMoveMappingSchema).min(1).max(200) }),
  z.object({
    confirm: z.boolean(),
    kind: z.literal("regex"),
    pattern: nonEmptyString,
    replacement: z.string(),
    roots: checkpointPaths,
  }),
]);

export type GitArcMoveMapping = z.infer<typeof GitArcMoveMappingSchema>;
export type GitArcMoveRequest = z.infer<typeof GitArcMoveRequestSchema>;

const checkpointBaseRequest = {
  cwd: nonEmptyString,
  harness: ProviderKeySchema.default("codex"),
  threadId: nonEmptyString,
};

const proposalCommitEntry = z.object({
  description: z.string(),
  includeNewer: z.boolean(),
  unclaimedSelection: z.object({
    paths: checkpointPaths,
    tree: checkpointSha,
  }).strict().optional(),
  mode: z.enum(["amend", "commit"]).optional(),
  proposalId: nonEmptyString,
  title: nonEmptyString,
});

export type GitArcProposalCommitEntry = z.infer<typeof proposalCommitEntry>;

export const GitCheckpointRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("arcAdoptSource"),
    source: GitArcAdoptionSourceSchema,
    /** Move only these live source claims. */
    paths: checkpointPaths.optional(),
    /** Hand the selected claims to this owned subagent instead of the caller. */
    releaseToSubagent: z.object({ kind: z.literal("subagent"), name: nonEmptyString }).strict().optional(),
    ...checkpointBaseRequest,
  }).strict().refine(input => !input.releaseToSubagent || input.paths, "Releasing adopted claims to a subagent requires selected paths."),
  z.object({
    action: z.literal("arcTransferClaims"),
    destination: z.object({ kind: z.literal("subagent"), name: nonEmptyString }).strict(),
    paths: checkpointPaths,
    ...checkpointBaseRequest,
  }).strict(),
  GitArcPlanClaimsSchema.safeExtend({ action: z.literal("planClaims"), start: z.boolean().default(false), ...checkpointBaseRequest }),
  GitArcClaimsSchema.extend({ action: z.literal("arcClaims"), ...checkpointBaseRequest }),
  z.object({ action: z.literal("arcScope"), ...checkpointBaseRequest }).strict(),
  z.object({
    action: z.literal("arcStatus"),
    full: z.array(GitArcStatusFullSchema).default([]),
    targetThreadId: nonEmptyString.optional(),
    ...checkpointBaseRequest,
  }).strict(),
  z.object({
    action: z.literal("plan"),
    adoptPaths: optionalCheckpointPaths.default([]),
    intentDescription: z.string().default(""),
    intentName: nonEmptyString,
    paths: optionalCheckpointPaths,
    roots: z.array(GitArcPlanRootSchema).default([]),
    ...checkpointBaseRequest,
  }).strict(),
  z.object({ action: z.literal("planAdd"), paths: optionalCheckpointPaths, roots: z.array(GitArcRootPathsSchema).default([]), ...checkpointBaseRequest }),
  z.object({ action: z.literal("planAdopt"), paths: optionalCheckpointPaths, roots: z.array(GitArcRootPathsSchema).default([]), ...checkpointBaseRequest }),
  z.object({ action: z.literal("planRemove"), paths: optionalCheckpointPaths, roots: z.array(GitArcRootPathsSchema).default([]), ...checkpointBaseRequest }),
  z.object({
    action: z.literal("planStart"),
    adoptPaths: optionalCheckpointPaths.default([]),
    intentDescription: z.string().default(""),
    intentName: nonEmptyString,
    paths: optionalCheckpointPaths,
    roots: z.array(GitArcPlanRootSchema).default([]),
    ...checkpointBaseRequest,
  }).strict(),
  z.object({
    action: z.literal("arcContinue"),
    checkpointCommit: checkpointSha.optional(),
    refs: z.array(GitArcMemberRefSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcStart"),
    checkpointCommit: checkpointSha.optional(),
    refs: z.array(GitArcMemberRefSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcWait"),
    checkpointCommit: checkpointSha.optional(),
    refs: z.array(GitArcMemberRefSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcAdd"),
    paths: optionalCheckpointPaths,
    roots: z.array(GitArcRootPathsSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcAdopt"),
    paths: optionalCheckpointPaths,
    roots: z.array(GitArcRootPathsSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcRemove"),
    paths: optionalCheckpointPaths,
    roots: z.array(GitArcRootPathsSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcRelease"),
    disown: z.boolean().default(false),
    ...checkpointBaseRequest,
  }),
  z.object({ action: z.literal("arcStash"), ...checkpointBaseRequest }).strict(),
  z.object({ action: z.literal("arcUnstash"), ...checkpointBaseRequest }).strict(),
  z.object({ action: z.literal("arcDiscardStash"), ...checkpointBaseRequest }).strict(),
  z.object({ action: z.literal("arcStack"), title: nonEmptyString, ...checkpointBaseRequest }).strict(),
  z.object({ action: z.literal("arcUnstack"), ...checkpointBaseRequest }).strict(),
  z.object({
    action: z.literal("arcMove"),
    move: GitArcMoveRequestSchema,
    rootId: rootId.optional(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("compare"),
    paths: checkpointPaths.optional(),
    ref: nonEmptyString.optional(),
    refs: z.array(GitArcInspectionMemberRefSchema).default([]),
    roots: z.array(GitArcRootPathsSchema).default([]),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("diff"),
    page: z.number().int().positive().optional(),
    paths: checkpointPaths.optional(),
    ref: nonEmptyString.optional(),
    refs: z.array(GitArcInspectionMemberRefSchema).default([]),
    roots: z.array(GitArcRootPathsSchema).default([]),
    targetThreadId: nonEmptyString.optional(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalCreate"),
    amend: z.boolean().default(false),
    amendProposalId: nonEmptyString.optional(),
    description: z.string(),
    freshDescription: z.string().optional(),
    freshTitle: nonEmptyString.optional(),
    paths: checkpointPaths.optional(),
    rootId: rootId.optional(),
    title: z.string(),
    ...checkpointBaseRequest,
  }).strict().superRefine((input, context) => {
    if (!input.amend && (input.freshTitle !== undefined || input.freshDescription !== undefined)) {
      context.addIssue(gitArcRejectionIssue({ reason: "unexpectedFreshMetadata" }, "Fresh commit metadata requires amend.", ["freshTitle"]));
    }
  }),
  z.object({
    action: z.literal("proposalRescind"),
    proposalId: nonEmptyString,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalSummaries"),
    proposalIds: z.array(nonEmptyString).min(1).max(200),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalState"),
    includeNewer: z.boolean(),
    includeUnclaimed: z.boolean().optional(),
    proposalId: nonEmptyString,
    ...checkpointBaseRequest,
  }),
  z.object({ action: z.literal("proposalCommit"), ...proposalCommitEntry.shape, ...checkpointBaseRequest }),
  z.object({
    action: z.literal("proposalCommitMany"),
    /** Committed in order, stopping at the first that fails; earlier ones stay landed. */
    entries: z.array(proposalCommitEntry).min(1).max(200),
    ...checkpointBaseRequest,
  }).strict(),
  z.object({
    action: z.literal("readDiffArtifact"),
    diffArtifactId: nonEmptyString.regex(/^[a-f0-9]{64}$/u),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcTree"),
    /** Hold the caller's own dirty claims back too, for a matched "before" build. */
    holdOwn: z.boolean().default(false),
    /** Absolute gitignored directory inside the repository to mirror the view into. */
    into: nonEmptyString.optional(),
    /** Repository paths the mirrored directory holds; every path when empty. */
    paths: optionalCheckpointPaths.default([]),
    ...checkpointBaseRequest,
  }).strict(),
  z.object({
    action: z.literal("restore"),
    checkpointCommit: checkpointSha.optional(),
    confirmRestore: z.boolean().optional(),
    paths: z.array(nonEmptyString).optional(),
    refs: z.array(GitArcMemberRefSchema).default([]),
    roots: z.array(GitArcRootPathsSchema).default([]),
    ...checkpointBaseRequest,
  }),
]).superRefine((input, context) => {
  if (
    (input.action === "planAdd" || input.action === "planAdopt" || input.action === "planRemove"
      || input.action === "arcAdd" || input.action === "arcAdopt" || input.action === "arcRemove")
    && !input.paths.length
    && !input.roots.length
  ) {
    context.addIssue(gitArcRejectionIssue({ reason: "missingSelectedPaths" }, "At least one path or root scope is required."));
  }
  if (
    input.action === "diff"
    && input.page !== undefined && input.page !== 1
    && (Boolean(input.paths?.length) || input.roots.some(({ paths }) => paths.length > 0))
  ) {
    context.addIssue(gitArcRejectionIssue({ reason: "selectedPathPaging" }, "Selected paths return one complete diff. Only page 1 is valid."));
  }
});

export type GitCheckpointRequest = z.infer<typeof GitCheckpointRequestSchema>;

const GitCheckpointCompareMemberSchema = z.object({
  phase: z.enum(["plan", "active", "stashed", "resolved"]).optional(),
  changes: z.array(GitCheckpointFileChangeSchema),
  checkpointCommit: checkpointSha,
  checkpointRef: nonEmptyString,
  intentName: z.string().nullable(),
  proposalId: nonEmptyString.optional(),
  repoRoot: nonEmptyString,
  rootId,
  scopePaths: optionalCheckpointPaths,
});

export const GitCheckpointCompareResultSchema = z.object({
  phase: z.enum(["plan", "active", "stashed", "resolved", "workspace"]).optional(),
  changes: z.array(GitCheckpointFileChangeSchema),
  checkpointCommit: checkpointSha,
  checkpointRef: nonEmptyString,
  hasUncommittedChanges: z.boolean().optional(),
  intentName: z.string().nullable(),
  members: z.array(GitCheckpointCompareMemberSchema).optional(),
  proposalId: nonEmptyString.optional(),
  repoRoot: nonEmptyString,
  scopePaths: optionalCheckpointPaths,
});
export type GitCheckpointCompareResult = z.infer<typeof GitCheckpointCompareResultSchema>;

export const GitArcStashResultSchema = z.object({
  conflictedPaths: z.array(nonEmptyString),
  phase: z.enum(["active", "stashed"]),
  stashedPaths: z.array(nonEmptyString),
}).strict();
export type GitArcStashResult = z.infer<typeof GitArcStashResultSchema>;

export const GitArcStackResultSchema = z.object({
  checkpointCommit: checkpointSha,
  intentName: z.string().nullable(),
  layerId: nonEmptyString,
  layerProposals: z.array(GitArcStackedProposalSchema).optional(),
  layerTitle: nonEmptyString,
  phase: z.enum(["active", "stashed", "resolved"]),
  proposalIds: z.array(nonEmptyString),
  repoRoot: nonEmptyString,
  scopePaths: optionalCheckpointPaths,
  stackTip: checkpointSha.nullable(),
}).strict();
export type GitArcStackResult = z.infer<typeof GitArcStackResultSchema>;

export const GitArcClaimViewSchema = z.object({
  /** Mirrored files rewritten or removed; present only when the view was mirrored into a directory. */
  deleted: z.number().int().nonnegative().optional(),
  head: checkpointSha.nullable(),
  held: z.array(z.object({ paths: z.array(nonEmptyString), threadId: nonEmptyString }).strict()),
  repoRoot: nonEmptyString,
  tree: checkpointSha,
  written: z.number().int().nonnegative().optional(),
}).strict();
export type GitArcClaimView = z.infer<typeof GitArcClaimViewSchema>;
export const GitArcClaimViewResultSchema = z.object({ repositories: z.array(GitArcClaimViewSchema) }).strict();
export type GitArcClaimViewResult = z.infer<typeof GitArcClaimViewResultSchema>;

const GitCheckpointCommitMessageSchema = z.object({
  description: z.string(),
  title: nonEmptyString,
}).strict();

export const GitCheckpointProposalSchema = z.object({
  amendability: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available") }).strict(),
    z.object({ reason: nonEmptyString, status: z.literal("unavailable") }).strict(),
  ]).nullable().optional(),
  amendTargetMessage: GitCheckpointCommitMessageSchema.nullable().optional().default(null),
  amendTargetSha: checkpointSha.nullable(),
  baseCommit: checkpointSha.nullable(),
  changes: z.array(GitCheckpointFileChangeSchema),
  committedSha: checkpointSha.nullable(),
  description: z.string(),
  freshChanges: z.array(GitCheckpointFileChangeSchema).nullable().optional().default(null),
  includeNewerAvailable: z.boolean(),
  unclaimedDirtAvailable: z.boolean().default(false).optional(),
  unclaimedDirt: z.object({
    changes: z.array(GitCheckpointFileChangeSchema),
    tree: checkpointSha,
  }).nullable().default(null).optional(),
  mode: z.enum(["amend", "commit"]),
  paths: checkpointPaths,
  proposalId: nonEmptyString,
  rootId: rootId.optional(),
  /** Title of the stack layer sealing this proposal. */
  sealedInLayer: z.string().nullable().default(null).optional(),
  /** Title of a lower stack layer that must land before this proposal can commit. */
  waitingForLayer: z.string().nullable().default(null).optional(),
  status: z.enum(["proposed", "committed", "rescinded", "superseded", "unavailable"]),
  supersededByProposalId: nonEmptyString.nullable(),
  supersededBySha: checkpointSha.nullable(),
  title: nonEmptyString,
  unavailableReason: z.string().nullable(),
  unavailableReasonCode: z.enum(["committed-outside-proposal"]).nullable().optional(),
});

export type GitCheckpointProposal = z.infer<typeof GitCheckpointProposalSchema>;

/** Landed proposals in commit order, and the first one that failed (later entries were not attempted). */
export const GitArcProposalCommitManyResultSchema = z.object({
  failed: z.object({ failure: GitArcFailureSchema, proposalId: nonEmptyString }).strict().nullable(),
  landed: z.array(GitCheckpointProposalSchema),
}).strict();
export type GitArcProposalCommitManyResult = z.infer<typeof GitArcProposalCommitManyResultSchema>;

/** Metadata-only proposal facts read in one batch: enough to decide and perform a commit, without diffs. */
export const GitArcProposalSummarySchema = z.object({
  description: z.string(),
  hasChanges: z.boolean(),
  mode: z.enum(["amend", "commit"]),
  proposalId: nonEmptyString,
  rootId: rootId.optional(),
  status: z.enum(["proposed", "committed", "rescinded", "superseded", "unavailable"]),
  title: z.string(),
}).strict();
export type GitArcProposalSummary = z.infer<typeof GitArcProposalSummarySchema>;
export const GitArcProposalSummariesSchema = z.object({ proposals: z.array(GitArcProposalSummarySchema) }).strict();
export type GitArcProposalSummaries = z.infer<typeof GitArcProposalSummariesSchema>;
