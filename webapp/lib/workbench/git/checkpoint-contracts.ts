/*
 * Exports:
 * - GitCheckpointRequestSchema/GitCheckpointRequest: validate every stateless checkpoint route action. Keywords: git, checkpoint, request, Zod.
 * - GitCheckpointFileChangeSchema/GitCheckpointFileChange: shared per-file compare and diff presentation. Keywords: git, checkpoint, file change.
 * - GitCheckpointProposalSchema/GitCheckpointProposal: shared durable proposal state shown in thread UI. Keywords: git, checkpoint, proposal, commit.
 */
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const checkpointSha = nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu);
const checkpointPaths = z.array(nonEmptyString).min(1);

const checkpointBaseRequest = {
  cwd: nonEmptyString,
  harness: z.enum(["codex", "copilot", "opencode"]).default("codex"),
  threadId: nonEmptyString,
};

export const GitCheckpointRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("plan"),
    intentDescription: z.string().default(""),
    intentName: nonEmptyString,
    paths: checkpointPaths,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcContinue"),
    checkpointCommit: checkpointSha,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcStart"),
    checkpointCommit: checkpointSha,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcAdd"),
    paths: checkpointPaths,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcAdopt"),
    paths: checkpointPaths,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcRemove"),
    paths: checkpointPaths,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("compare"),
    paths: checkpointPaths.optional(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("diff"),
    paths: checkpointPaths.optional(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalCreate"),
    amend: z.boolean().default(false),
    description: z.string(),
    paths: checkpointPaths.optional(),
    title: z.string(),
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
    checkpointCommit: checkpointSha,
    confirmRestore: z.boolean().optional(),
    paths: z.array(nonEmptyString).optional(),
    ...checkpointBaseRequest,
  }),
]);

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

export const GitCheckpointCompareResultSchema = z.object({
  changes: z.array(GitCheckpointFileChangeSchema),
  checkpointCommit: checkpointSha,
  checkpointRef: nonEmptyString,
  intentName: z.string().nullable(),
  repoRoot: nonEmptyString,
  scopePaths: checkpointPaths,
});
export type GitCheckpointCompareResult = z.infer<typeof GitCheckpointCompareResultSchema>;

export const GitCheckpointProposalSchema = z.object({
  amendTargetSha: checkpointSha.nullable(),
  baseCommit: checkpointSha,
  changes: z.array(GitCheckpointFileChangeSchema),
  committedSha: checkpointSha.nullable(),
  description: z.string(),
  includeNewerAvailable: z.boolean(),
  mode: z.enum(["amend", "commit"]),
  paths: checkpointPaths,
  proposalId: nonEmptyString,
  status: z.enum(["proposed", "committed", "superseded", "unavailable"]),
  supersededByProposalId: nonEmptyString.nullable(),
  supersededBySha: checkpointSha.nullable(),
  title: nonEmptyString,
  unavailableReason: z.string().nullable(),
});

export type GitCheckpointProposal = z.infer<typeof GitCheckpointProposalSchema>;
