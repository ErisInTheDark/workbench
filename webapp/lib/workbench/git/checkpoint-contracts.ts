/*
 * Exports:
 * - GitCheckpointRequestSchema/GitCheckpointRequest: validate every stateless checkpoint route action. Keywords: git, checkpoint, request, Zod.
 * - GitCheckpointFileChangeSchema/GitCheckpointFileChange: shared per-file compare and diff presentation. Keywords: git, checkpoint, file change.
 * - GitCheckpointProposalSchema/GitCheckpointProposal: shared durable proposal state shown in thread UI. Keywords: git, checkpoint, proposal, commit.
 * - GitArcMoveMappingSchema/GitArcMoveRequestSchema: validate bounded explicit and regex arc move requests. Keywords: git, arc, move, mapping.
 */
import { z } from "zod";

import { ORCHESTRATOR_RELOAD_SCOPES } from "../orchestrator-reload";

const nonEmptyString = z.string().trim().min(1);
const checkpointSha = nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu);
const checkpointPaths = z.array(nonEmptyString).min(1);
const optionalCheckpointPaths = z.array(nonEmptyString);
const reloadScopes = z.array(z.enum(ORCHESTRATOR_RELOAD_SCOPES)).default([]);

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
    reloadScopes,
    ...checkpointBaseRequest,
  }),
  z.object({ action: z.literal("planAdd"), paths: checkpointPaths, ...checkpointBaseRequest }),
  z.object({ action: z.literal("planAdopt"), paths: checkpointPaths, ...checkpointBaseRequest }),
  z.object({ action: z.literal("planRemove"), paths: checkpointPaths, ...checkpointBaseRequest }),
  z.object({
    action: z.literal("planStart"),
    adoptPaths: optionalCheckpointPaths.default([]),
    intentDescription: z.string().default(""),
    intentName: nonEmptyString,
    paths: optionalCheckpointPaths,
    reloadScopes,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcContinue"),
    checkpointCommit: checkpointSha,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("arcStart"),
    checkpointCommit: checkpointSha.optional(),
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
    action: z.literal("arcMove"),
    move: GitArcMoveRequestSchema,
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("compare"),
    checkpointCommit: checkpointSha.optional(),
    paths: checkpointPaths.optional(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("diff"),
    checkpointCommit: checkpointSha.optional(),
    paths: checkpointPaths.optional(),
    ...checkpointBaseRequest,
  }),
  z.object({
    action: z.literal("proposalCreate"),
    amend: z.boolean().default(false),
    amendProposalId: nonEmptyString.optional(),
    description: z.string(),
    paths: checkpointPaths.optional(),
    replaceProposalId: nonEmptyString.optional(),
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
  status: z.enum(["proposed", "committed", "rescinded", "superseded", "unavailable"]),
  supersededByProposalId: nonEmptyString.nullable(),
  supersededBySha: checkpointSha.nullable(),
  title: nonEmptyString,
  unavailableReason: z.string().nullable(),
});

export type GitCheckpointProposal = z.infer<typeof GitCheckpointProposalSchema>;
