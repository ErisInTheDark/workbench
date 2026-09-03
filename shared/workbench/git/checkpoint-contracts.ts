/*
 * Exports:
 * - GitArcRootPathsSchema/GitArcRootPaths and GitArcPlanRootSchema/GitArcPlanRoot: validate root-qualified path selections. Keywords: git, arc, root, paths, plan.
 * - GitArcMemberRefSchema/GitArcMemberRef and GitArcInspectionMemberRefSchema/GitArcInspectionMemberRef: validate lifecycle SHA refs and broader inspection refs. Keywords: git, arc, ref, proposal, workspace.
 * - GitArcMoveMappingSchema/GitArcMoveRequestSchema: validate bounded explicit and regex arc move requests. Keywords: git, arc, move, mapping.
 * - GitArcMoveMapping/GitArcMoveRequest: expose validated move request types. Keywords: git, arc, move, type.
 * - GitCheckpointRequestSchema/GitCheckpointRequest: validate every stateless checkpoint route action, including unscoped diff pages. Keywords: git, checkpoint, request, diff, page, Zod.
 * - GitCheckpointFileChangeSchema/GitCheckpointFileChange: shared per-file compare and diff presentation. Keywords: git, checkpoint, file change.
 * - GitCheckpointCompareResultSchema/GitCheckpointCompareResult: validate repo-local and workspace inspection results. Keywords: git, checkpoint, compare, proposal.
 * - GitCheckpointProposalSchema/GitCheckpointProposal: shared durable proposal state shown in thread UI. Keywords: git, checkpoint, proposal, commit.
 */
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const checkpointSha = nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu);
const checkpointPaths = z.array(nonEmptyString).min(1);
const optionalCheckpointPaths = z.array(nonEmptyString);
const rootId = nonEmptyString;

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
  harness: z.enum(["codex", "copilot", "opencode"]).default("codex"),
  threadId: nonEmptyString,
};

export const GitCheckpointRequestSchema = z.discriminatedUnion("action", [
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
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalCreate"),
    amend: z.boolean().default(false),
    amendProposalId: nonEmptyString.optional(),
    description: z.string(),
    paths: checkpointPaths.optional(),
    replaceProposalId: nonEmptyString.optional(),
    rootId: rootId.optional(),
    title: z.string(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalRescind"),
    proposalId: nonEmptyString,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalState"),
    includeNewer: z.boolean(),
    proposalId: nonEmptyString,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalCommit"),
    description: z.string(),
    includeNewer: z.boolean(),
    proposalId: nonEmptyString,
    title: nonEmptyString,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("readDiffArtifact"),
    diffArtifactId: nonEmptyString.regex(/^[a-f0-9]{64}$/u),
    ...checkpointBaseRequest,
  }),
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
    context.addIssue({ code: "custom", message: "At least one path or root scope is required." });
  }
  if (
    input.action === "diff"
    && input.page !== undefined
    && (Boolean(input.paths?.length) || input.roots.some(({ paths }) => paths.length > 0))
  ) {
    context.addIssue({ code: "custom", message: "Git arc diff page cannot be combined with selected paths." });
  }
});

export type GitCheckpointRequest = z.infer<typeof GitCheckpointRequestSchema>;

export const GitCheckpointFileChangeSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: z.string(),
  kind: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add") }),
    z.object({ type: z.literal("delete") }),
    z.object({ move_path: z.string().nullable(), type: z.literal("update") }),
  ]),
  path: nonEmptyString,
});

export type GitCheckpointFileChange = z.infer<typeof GitCheckpointFileChangeSchema>;

const GitCheckpointCompareMemberSchema = z.object({
  changes: z.array(GitCheckpointFileChangeSchema),
  checkpointCommit: checkpointSha,
  checkpointRef: nonEmptyString,
  intentName: z.string().nullable(),
  proposalId: nonEmptyString.optional(),
  repoRoot: nonEmptyString,
  rootId,
  scopePaths: checkpointPaths,
});

export const GitCheckpointCompareResultSchema = z.object({
  changes: z.array(GitCheckpointFileChangeSchema),
  checkpointCommit: checkpointSha,
  checkpointRef: nonEmptyString,
  hasUncommittedChanges: z.boolean().optional(),
  intentName: z.string().nullable(),
  members: z.array(GitCheckpointCompareMemberSchema).optional(),
  proposalId: nonEmptyString.optional(),
  repoRoot: nonEmptyString,
  scopePaths: checkpointPaths,
});
export type GitCheckpointCompareResult = z.infer<typeof GitCheckpointCompareResultSchema>;

export const GitCheckpointProposalSchema = z.object({
  amendability: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available") }).strict(),
    z.object({ reason: nonEmptyString, status: z.literal("unavailable") }).strict(),
  ]).nullable().optional(),
  amendTargetSha: checkpointSha.nullable(),
  baseCommit: checkpointSha,
  changes: z.array(GitCheckpointFileChangeSchema),
  committedSha: checkpointSha.nullable(),
  description: z.string(),
  includeNewerAvailable: z.boolean(),
  mode: z.enum(["amend", "commit"]),
  paths: checkpointPaths,
  proposalId: nonEmptyString,
  rootId: rootId.optional(),
  status: z.enum(["proposed", "committed", "rescinded", "superseded", "unavailable"]),
  supersededByProposalId: nonEmptyString.nullable(),
  supersededBySha: checkpointSha.nullable(),
  title: nonEmptyString,
  unavailableReason: z.string().nullable(),
  unavailableReasonCode: z.enum(["committed-outside-proposal"]).nullable().optional(),
});

export type GitCheckpointProposal = z.infer<typeof GitCheckpointProposalSchema>;
