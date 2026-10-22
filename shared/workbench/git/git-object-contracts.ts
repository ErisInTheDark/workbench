/*
 * Exports:
 * - GitObjectRefSchema/GitObjectRef: one commit or stash a git tab shows.
 * - GitObjectRequestSchema/GitObjectFileRequestSchema: read an object's detail, or one of its files' diff or preview.
 * - GitObjectFileSchema/GitObjectFile: one changed file of an object, keyed by an identity the content reads echo.
 * - GitObjectDetailSchema/GitObjectDetail: an object's message, author, parents, files, undo eligibility and the threads
 *   whose accepted proposals made it.
 * - GitStashEntrySchema/GitStashListSchema/GitStashList: the checkout's stashes, newest first.
 * - GitBranchSchema/GitBranchListSchema/GitBranchList: local branches with upstream counts and where each is checked out.
 * - GitCheckoutOwnerSchema/GitCheckoutOwner: a thread whose live claims or pending proposals a ref move would disturb.
 * - GitRefMutationSchema/GitRefMutation: stash restore/drop, branch switch/create, worktree creation and undoing HEAD.
 * - GitRefMutationResultSchema/GitRefMutationResult: what a ref mutation did, or which threads it would disturb.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity";
import { WorkbenchThreadSidebarEntrySchema } from "../thread/thread-state";
import { GitBranchNameSchema } from "./git-peer-contracts";
import { WorkingTreeFileSchema } from "./working-tree-contracts";

const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const count = z.number().int().nonnegative();

export const GitCheckoutOwnerSchema = z.object({
  id: z.string(), projectId: z.string(), entry: WorkbenchThreadSidebarEntrySchema,
}).strict();
export type GitCheckoutOwner = z.infer<typeof GitCheckoutOwnerSchema>;

export const GitObjectRefSchema = z.object({ kind: z.enum(["commit", "stash"]), sha }).strict();
export type GitObjectRef = z.infer<typeof GitObjectRefSchema>;

export const GitObjectRequestSchema = z.object({ projectId: ProjectIdSchema, object: GitObjectRefSchema }).strict();
export const GitObjectFileRequestSchema = GitObjectRequestSchema.extend({ path: WorkingTreeFileSchema.shape.path }).strict();

export const GitObjectFileSchema = WorkingTreeFileSchema.pick({
  path: true, oldPath: true, status: true, baseBlob: true, blob: true, baseMode: true, mode: true,
  identity: true, additions: true, deletions: true, binary: true,
}).strict();
export type GitObjectFile = z.infer<typeof GitObjectFileSchema>;

export const GitObjectDetailSchema = z.object({
  object: GitObjectRefSchema,
  parents: z.array(sha),
  subject: z.string(),
  body: z.string(),
  author: z.string(),
  /** Author time, epoch milliseconds. */
  authoredAt: count,
  /** Why this commit cannot be undone; null when it is HEAD and unpublished. Always set for stashes. */
  undoBlocked: z.string().nullable(),
  /** Threads whose accepted proposal became this commit. */
  threads: z.array(GitCheckoutOwnerSchema),
  files: z.array(GitObjectFileSchema),
}).strict();
export type GitObjectDetail = z.infer<typeof GitObjectDetailSchema>;

export const GitStashEntrySchema = z.object({
  sha, index: count, message: z.string(),
  /** Epoch milliseconds. */
  createdAt: count,
}).strict();
export type GitStashEntry = z.infer<typeof GitStashEntrySchema>;
export const GitStashListSchema = z.object({ stashes: z.array(GitStashEntrySchema) }).strict();
export type GitStashList = z.infer<typeof GitStashListSchema>;

export const GitBranchSchema = z.object({
  name: GitBranchNameSchema,
  head: sha,
  /** Commit time, epoch milliseconds. */
  committedAt: count,
  upstream: z.object({ name: z.string(), ahead: count, behind: count }).strict().nullable(),
  /** Another worktree holding this branch; Git refuses to check it out twice. */
  worktree: z.string().nullable(),
}).strict();
export type GitBranch = z.infer<typeof GitBranchSchema>;
export const GitBranchListSchema = z.object({
  current: GitBranchNameSchema.nullable(),
  head: sha.nullable(),
  branches: z.array(GitBranchSchema),
}).strict();
export type GitBranchList = z.infer<typeof GitBranchListSchema>;

const mutation = z.object({ projectId: ProjectIdSchema });
export const GitRefMutationSchema = z.discriminatedUnion("action", [
  mutation.extend({ action: z.literal("restoreStash"), sha }).strict(),
  mutation.extend({ action: z.literal("dropStash"), sha }).strict(),
  /** `disturb` admits a move that strands threads' claims or proposals; without it such a move only reports them. */
  mutation.extend({ action: z.literal("switchBranch"), branch: GitBranchNameSchema, disturb: z.boolean() }).strict(),
  mutation.extend({ action: z.literal("createBranch"), branch: GitBranchNameSchema }).strict(),
  /** Checks `branch` out in a new linked worktree, creating it from HEAD when `create`. */
  mutation.extend({ action: z.literal("createWorktree"), branch: GitBranchNameSchema, create: z.boolean() }).strict(),
  /** Moves HEAD back to its parent, keeping the commit's changes in the worktree. */
  mutation.extend({ action: z.literal("undoCommit"), sha, disturb: z.boolean() }).strict(),
]);
export type GitRefMutation = z.infer<typeof GitRefMutationSchema>;

export const GitRefMutationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    warnings: z.array(z.string()),
    /** Files a restore left with conflict markers. */
    conflicts: z.array(z.string()),
    /** The new worktree's folder, and its catalogue project once discovered. */
    worktree: z.object({ path: z.string(), projectId: z.string().nullable() }).strict().nullable(),
  }).strict(),
  z.object({ status: z.literal("disturbs"), owners: z.array(GitCheckoutOwnerSchema) }).strict(),
]);
export type GitRefMutationResult = z.infer<typeof GitRefMutationResultSchema>;
