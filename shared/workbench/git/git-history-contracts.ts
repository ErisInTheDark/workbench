/*
 * Exports:
 * - GIT_HISTORY_MAX_LIMIT: the deepest history page one observation reads.
 * - GitHistoryRequestSchema/GitHistoryRequest: how much of a folder's HEAD history to read, and which peers mark unsent commits.
 * - GitHistoryCommitSchema/GitHistoryCommit: one commit with its origin and peer delivery marks.
 * - GitHistorySchema/GitHistory: newest-first HEAD history; callers grow `limit` to scroll further.
 * - GitPushRequestSchema/GitPushResultSchema/GitPushResult: push the checked-out branch to its upstream.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity";
import { GitBranchNameSchema, GitPeerAddressSchema } from "./git-peer-contracts";

const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
export const GIT_HISTORY_MAX_LIMIT = 2_000;

export const GitHistoryRequestSchema = z.object({
  limit: z.number().int().min(1).max(GIT_HISTORY_MAX_LIMIT),
  /** Peers whose fetched tips decide `unsent`; a peer never fetched marks nothing. */
  peers: z.array(GitPeerAddressSchema).max(32),
}).strict();
export type GitHistoryRequest = z.infer<typeof GitHistoryRequestSchema>;

export const GitHistoryCommitSchema = z.object({
  commit: sha,
  subject: z.string(),
  author: z.string(),
  /** Author time, epoch milliseconds. */
  authoredAt: z.number().int().nonnegative(),
  /** Not on the branch's upstream; false without an upstream. */
  unpushed: z.boolean(),
  /** Missing from at least one fetched peer tip. */
  unsent: z.boolean(),
}).strict();
export type GitHistoryCommit = z.infer<typeof GitHistoryCommitSchema>;

export const GitHistorySchema = z.object({
  /** Null while HEAD is detached. */
  branch: GitBranchNameSchema.nullable(),
  head: sha.nullable(),
  commits: z.array(GitHistoryCommitSchema),
  /** True when HEAD's whole history fits in the requested limit. */
  complete: z.boolean(),
}).strict();
export type GitHistory = z.infer<typeof GitHistorySchema>;

export const GitPushRequestSchema = z.object({ projectId: ProjectIdSchema }).strict();
export const GitPushResultSchema = z.object({ branch: GitBranchNameSchema, upstream: z.string().max(512), pushed: z.number().int().nonnegative() }).strict();
export type GitPushResult = z.infer<typeof GitPushResultSchema>;
