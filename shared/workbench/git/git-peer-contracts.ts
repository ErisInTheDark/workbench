/*
 * Exports:
 * - GitBranchNameSchema: a branch name safe to place under `refs/heads/` and peer tracking refs.
 * - GitPeerAddressSchema/GitPeerAddress: one folder on another daemon sharing a folder's logical project.
 * - GitPeerCommitsRequestSchema/GitPeerCommitsRequest: directional preview or full-history demand.
 * - GitPeerCommitSchema/GitPeerCommitsSchema/GitPeerCommits: transferable commit subjects from captured branch tips.
 * - GitBranchPositionSchema/GitBranchPosition: a checkout's branch, HEAD and counts against each requested peer's tracking ref.
 * - GitPeerStatusSchema/GitPeerStatus, WorkspaceGitPeersSchema/WorkspaceGitPeers: the app's peer rows for one folder.
 * - GitPeerTransferSchema/GitPeerTransfer: a browser Pull or Send between a folder and one peer.
 * - GitPeerSyncModeSchema/GitPeerSyncMode: user-selected merge or sender-side rebase policy.
 * - GitPeerTransferResultSchema/GitPeerTransferResult: complete or device-specific interrupted transfer.
 * - GitPeerIntegrationSnapshotSchema/GitPeerIntegrationSnapshot: inspected receiver and incoming tips with ancestry counts.
 * - GitPeerApplyOptions: pinned tips and local integration mode for one guarded mutation.
 * - GitPeerIntegrationResultSchema/GitPeerIntegrationResult: what integrating a peer's branch did.
 * - GIT_PEER_ROUTES/GIT_PEER_TIP_HEADER/GIT_PEER_NO_BUNDLE_HEADER: daemon HTTP routes, the header naming a sent branch tip
 *   and the marker for a receive without a bundle.
 * - GitPeerHavesRequestSchema, GitPeerBundleRequestSchema, GitPeerReceiveQuerySchema, GitPeerIntegrateRequestSchema,
 *   GitPeerHavesResultSchema, GitPeerReceiveResultSchema: daemon HTTP bodies for one app-relayed transfer.
 * - GIT_PEER_FETCH_REQUEST_METHOD/GIT_PEER_FETCH_RESULT_METHOD, GitPeerFetchQuestionSchema/GitPeerFetchQuestion,
 *   GitPeerFetchOutcomeSchema/GitPeerFetchOutcome, GitPeerFetchRequestNotificationSchema, GitPeerFetchResultNotificationSchema:
 *   a daemon asking its connected apps to fetch a named peer's branch for `wb git integrate`.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema } from "../identity";
import { ProjectLocationReferenceSchema } from "../project/project-location";

const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const failure = z.string().max(512).nullable();
const count = z.number().int().nonnegative();

export const GitBranchNameSchema = z.string().min(1).max(255)
  .regex(/^[^\u0000- ~^:?*[\\\u007f]+$/u)
  .refine(name => !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".")
    && !name.endsWith(".lock") && !name.includes("..") && !name.includes("//") && !name.includes("@{")
    && !name.split("/").some(part => part.startsWith(".")), "Invalid branch name.");

export const GitPeerAddressSchema = z.object({ daemonId: DaemonIdSchema, projectId: ProjectIdSchema }).strict();
export type GitPeerAddress = z.infer<typeof GitPeerAddressSchema>;

export const GitPeerCommitsRequestSchema = z.object({
  peer: GitPeerAddressSchema,
  branch: GitBranchNameSchema,
  action: z.enum(["pull", "send"]),
  all: z.boolean(),
}).strict();
export type GitPeerCommitsRequest = z.infer<typeof GitPeerCommitsRequestSchema>;
export const GitPeerCommitSchema = z.object({ commit: sha, subject: z.string() }).strict();
export const GitPeerCommitsSchema = z.object({
  branch: GitBranchNameSchema,
  head: sha.nullable(),
  tip: sha,
  total: count,
  commits: z.array(GitPeerCommitSchema),
}).strict();
export type GitPeerCommits = z.infer<typeof GitPeerCommitsSchema>;

export const GitBranchPositionSchema = z.object({
  /** Null while HEAD is detached. */
  branch: GitBranchNameSchema.nullable(),
  /** Null on an unborn branch. */
  head: sha.nullable(),
  peers: z.array(GitPeerAddressSchema.extend({
    /** This checkout's copy of the peer's same-named branch; null until first fetched. */
    tip: sha.nullable(),
    /** Commits the peer lacks. */
    ahead: count,
    /** Commits this checkout lacks. */
    behind: count,
  }).strict()),
}).strict();
export type GitBranchPosition = z.infer<typeof GitBranchPositionSchema>;

export const GitPeerStatusSchema = GitPeerAddressSchema.extend({
  hostname: z.string(),
  rootPath: z.string(),
  /**
   * `otherBranch`: the peer has another branch checked out. `unsupported`: the peer's daemon predates peer sync.
   * `offline`: the app cannot reach it now.
   */
  state: z.enum(["pending", "current", "otherBranch", "offline", "unsupported", "failed"]),
  ahead: count,
  behind: count,
  failure,
}).strict();
export type GitPeerStatus = z.infer<typeof GitPeerStatusSchema>;
export const WorkspaceGitPeersSchema = z.object({
  branch: GitBranchNameSchema.nullable(),
  peers: z.array(GitPeerStatusSchema),
}).strict();
export type WorkspaceGitPeers = z.infer<typeof WorkspaceGitPeersSchema>;

export const GitPeerSyncModeSchema = z.enum(["merge", "rebase"]);
export type GitPeerSyncMode = z.infer<typeof GitPeerSyncModeSchema>;

/** `pull` brings the peer's commits into `location`; `send` has the peer pull from `location`. */
export const GitPeerTransferSchema = z.object({
  action: z.enum(["pull", "send"]),
  location: ProjectLocationReferenceSchema,
  peer: GitPeerAddressSchema,
  mode: GitPeerSyncModeSchema,
}).strict();
export type GitPeerTransfer = z.infer<typeof GitPeerTransferSchema>;

export const GitPeerIntegrationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({
    kind: z.literal("applied"), mode: z.enum(["fastForward", "replay", "merge"]), fromSha: sha, toSha: sha,
    warnings: z.array(z.string().max(512)),
  }).strict(),
  z.object({ kind: z.literal("blocked"), reason: failure, conflicts: z.array(z.string()) }).strict(),
]);
export type GitPeerIntegrationResult = z.infer<typeof GitPeerIntegrationResultSchema>;

export const GitPeerIntegrationSnapshotSchema = z.object({
  head: sha, incoming: sha, ahead: count, behind: count,
}).strict();
export type GitPeerIntegrationSnapshot = z.infer<typeof GitPeerIntegrationSnapshotSchema>;

export const GitPeerTransferResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({
    kind: z.literal("applied"), mode: GitPeerSyncModeSchema, fromSha: sha, toSha: sha,
    warnings: z.array(z.string().max(512)),
  }).strict(),
  z.object({
    kind: z.literal("blocked"), location: GitPeerAddressSchema,
    progress: z.enum(["none", "senderUpdated", "uncertain"]),
    reason: z.string().max(1024), conflicts: z.array(z.string()),
  }).strict(),
]);
export type GitPeerTransferResult = z.infer<typeof GitPeerTransferResultSchema>;

export const GIT_PEER_ROUTES = {
  haves: "/daemon/git-peer/haves",
  bundle: "/daemon/git-peer/bundle",
  receive: "/daemon/git-peer/receive",
  inspect: "/daemon/git-peer/integration/inspect",
  integrate: "/daemon/git-peer/integration/apply",
} as const;
export const GIT_PEER_TIP_HEADER = "x-workbench-git-tip";
/** Marks a receive that records a tip the receiver already holds, so no bundle body follows. */
export const GIT_PEER_NO_BUNDLE_HEADER = "x-workbench-git-no-bundle";

/** Commits the receiver already holds, so the sender's bundle carries only what is new. */
export const GitPeerHavesRequestSchema = z.object({
  projectId: ProjectIdSchema, peer: GitPeerAddressSchema, branch: GitBranchNameSchema,
}).strict();
export const GitPeerHavesResultSchema = z.object({ haves: z.array(sha).max(8) }).strict();
export const GitPeerBundleRequestSchema = z.object({
  projectId: ProjectIdSchema, branch: GitBranchNameSchema, haves: z.array(sha).max(8),
}).strict();
/** The bundle streams as the request body; an empty body records a tip the receiver already holds. */
export const GitPeerReceiveQuerySchema = z.object({
  projectId: ProjectIdSchema, peerDaemonId: DaemonIdSchema, peerProjectId: ProjectIdSchema,
  branch: GitBranchNameSchema, tip: sha,
}).strict();
export const GitPeerReceiveResultSchema = z.object({ tip: sha }).strict();
export const GitPeerIntegrateRequestSchema = GitPeerHavesRequestSchema.extend({
  expectedHead: sha,
  incoming: sha,
  mode: z.enum(["fastForward", "replay", "merge"]),
}).strict();
export type GitPeerApplyOptions = Pick<z.infer<typeof GitPeerIntegrateRequestSchema>, "expectedHead" | "incoming" | "mode">;

/**
 * A daemon asks its connected apps to fetch a named peer's branch into one of its folders, for agents that run
 * `wb git integrate`. Apps acknowledge at once, then answer with the fetched tip or a failure.
 */
export const GIT_PEER_FETCH_REQUEST_METHOD = "workbench/git-peer/fetch";
export const GIT_PEER_FETCH_RESULT_METHOD = "workbench/git-peer/fetch-result";
export const GitPeerFetchQuestionSchema = z.object({
  projectId: ProjectIdSchema,
  branch: GitBranchNameSchema,
  /** The peer's hostname, matched case-insensitively. */
  host: z.string().min(1).max(255),
  /** A path suffix telling apart several folders on that host. */
  folder: z.string().min(1).max(4096).nullable(),
}).strict();
export type GitPeerFetchQuestion = z.infer<typeof GitPeerFetchQuestionSchema>;
export const GitPeerFetchOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted") }).strict(),
  z.object({ kind: z.literal("fetched"), peer: GitPeerAddressSchema, hostname: z.string(), rootPath: z.string(), tip: sha }).strict(),
  z.object({ kind: z.literal("failed"), failure: z.string().max(1024) }).strict(),
]);
export type GitPeerFetchOutcome = z.infer<typeof GitPeerFetchOutcomeSchema>;
export const GitPeerFetchRequestNotificationSchema = z.object({
  method: z.literal(GIT_PEER_FETCH_REQUEST_METHOD),
  params: z.object({ requestId: z.uuid(), question: GitPeerFetchQuestionSchema }).strict(),
});
export const GitPeerFetchResultNotificationSchema = z.object({
  method: z.literal(GIT_PEER_FETCH_RESULT_METHOD),
  params: z.object({ requestId: z.uuid(), outcome: GitPeerFetchOutcomeSchema }).strict(),
});
