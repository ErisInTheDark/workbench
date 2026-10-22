/*
 * Exports:
 * - WORKBENCH_GIT_ARC_ACTION_BY_METHOD/WorkbenchDaemonGitArcMethod: map browser Git arc methods to existing Git actions.
 * - WorkbenchGitArcSuccess: exact acknowledgement for browser Git arc mutations.
 * - gitDaemonRequests: daemon requests for working-tree reads and edits, commit and stash reads, ref moves, upstream pushes
 *   and browser Git arc actions.
 */
import { z } from "zod";
import {
  GitArcProposalCommitManyResultSchema,
  GitArcStashResultSchema,
  GitCheckpointCompareResultSchema,
  GitCheckpointProposalSchema,
  type GitArcProposalCommitManyResult,
  type GitArcStashResult,
  type GitCheckpointCompareResult,
  type GitCheckpointProposal,
  type GitCheckpointRequest,
} from "../../git/checkpoint-contracts.ts";
import {
  WorkingTreeDiffSchema, WorkingTreePreviewSchema, WorkingTreeReadSchema, WorkingTreeResultSchema,
  type WorkingTreeDiff, type WorkingTreeFileRequest, type WorkingTreeMutation, type WorkingTreePreview, type WorkingTreeRead,
  type WorkingTreeResult,
} from "../../git/working-tree-contracts.ts";
import { GitPushResultSchema, type GitPushResult } from "../../git/git-history-contracts.ts";
import {
  GitObjectDetailSchema, GitRefMutationResultSchema,
  type GitObjectDetail, type GitObjectRef, type GitRefMutation, type GitRefMutationResult,
} from "../../git/git-object-contracts.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";

export interface WorkbenchGitArcSuccess {
  ok: true;
}

type GitArcParams<TAction extends GitCheckpointRequest["action"]> = Omit<
  Extract<GitCheckpointRequest, { action: TAction }>,
  "action"
>;

export const WORKBENCH_GIT_ARC_ACTION_BY_METHOD = {
  "git/arc/compare": "compare",
  "git/arc/diff-artifact/read": "readDiffArtifact",
  "git/arc/proposal/commit": "proposalCommit",
  "git/arc/proposals/commit": "proposalCommitMany",
  "git/arc/proposal/read": "proposalState",
  "git/arc/release": "arcRelease",
  "git/arc/remove": "arcRemove",
  "git/arc/restore": "restore",
  "git/arc/stash": "arcStash",
  "git/arc/unstash": "arcUnstash",
  "git/arc/stash/discard": "arcDiscardStash",
} as const satisfies Record<string, GitCheckpointRequest["action"]>;

export type WorkbenchDaemonGitArcMethod = keyof typeof WORKBENCH_GIT_ARC_ACTION_BY_METHOD;

/** Git arc results are checked against their declared type, since daemon dispatch publishes exactly what the schema admits. */
const arc = <Action extends GitCheckpointRequest["action"], Result>(result: z.ZodType<Result>) =>
  defineDaemonRequest<GitArcParams<Action>, Result>()({ route: "threadCwd", result });
const acknowledged = z.object({ ok: z.literal(true) }).strict();

export const gitDaemonRequests = {
  "git/working-tree/read": defineDaemonRequest<{ projectId: string; preferCached?: boolean }, WorkingTreeRead>()({
    route: "folder", result: WorkingTreeReadSchema,
  }),
  "git/working-tree/diff": defineDaemonRequest<WorkingTreeFileRequest, WorkingTreeDiff>()({ route: "folder", result: WorkingTreeDiffSchema }),
  "git/working-tree/preview": defineDaemonRequest<WorkingTreeFileRequest, WorkingTreePreview>()({ route: "folder", result: WorkingTreePreviewSchema }),
  "git/working-tree/mutate": defineDaemonRequest<WorkingTreeMutation, WorkingTreeResult>()({ route: "folder", result: WorkingTreeResultSchema }),
  "git/push": defineDaemonRequest<{ projectId: string }, GitPushResult>()({ route: "folder", result: GitPushResultSchema }),
  "git/object/read": defineDaemonRequest<{ projectId: string; object: GitObjectRef }, GitObjectDetail>()({
    route: "folder", result: GitObjectDetailSchema,
  }),
  "git/object/diff": defineDaemonRequest<{ projectId: string; object: GitObjectRef; path: string }, WorkingTreeDiff>()({
    route: "folder", result: WorkingTreeDiffSchema,
  }),
  "git/object/preview": defineDaemonRequest<{ projectId: string; object: GitObjectRef; path: string }, WorkingTreePreview>()({
    route: "folder", result: WorkingTreePreviewSchema,
  }),
  "git/ref/mutate": defineDaemonRequest<GitRefMutation, GitRefMutationResult>()({ route: "folder", result: GitRefMutationResultSchema }),
  "git/arc/compare": arc<"compare", GitCheckpointCompareResult>(GitCheckpointCompareResultSchema),
  "git/arc/diff-artifact/read": arc<"readDiffArtifact", string>(z.string()),
  "git/arc/proposal/commit": arc<"proposalCommit", GitCheckpointProposal>(GitCheckpointProposalSchema),
  "git/arc/proposals/commit": arc<"proposalCommitMany", GitArcProposalCommitManyResult>(GitArcProposalCommitManyResultSchema),
  "git/arc/proposal/read": arc<"proposalState", GitCheckpointProposal>(GitCheckpointProposalSchema),
  "git/arc/release": arc<"arcRelease", WorkbenchGitArcSuccess>(acknowledged),
  "git/arc/remove": arc<"arcRemove", WorkbenchGitArcSuccess>(acknowledged),
  "git/arc/restore": arc<"restore", WorkbenchGitArcSuccess>(acknowledged),
  "git/arc/stash": arc<"arcStash", GitArcStashResult>(GitArcStashResultSchema),
  "git/arc/unstash": arc<"arcUnstash", GitArcStashResult>(GitArcStashResultSchema),
  "git/arc/stash/discard": arc<"arcDiscardStash", WorkbenchGitArcSuccess>(acknowledged),
};
