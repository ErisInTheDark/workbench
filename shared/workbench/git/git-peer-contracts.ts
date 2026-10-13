/*
 * Exports:
 * - GitBranchNameSchema: a branch name safe to place under `refs/heads/` and peer tracking refs.
 * - GitPeerAddressSchema/GitPeerAddress: one folder on another daemon sharing a folder's logical project.
 * - GitBranchPositionSchema/GitBranchPosition: a checkout's branch, HEAD and counts against each requested peer's tracking ref.
 * - GitPeerStatusSchema/GitPeerStatus, WorkspaceGitPeersSchema/WorkspaceGitPeers: the app's peer rows for one folder.
 * - GitPeerTransferSchema/GitPeerTransfer: a browser Pull or Send between a folder and one peer.
 * - GitPeerIntegrationResultSchema/GitPeerIntegrationResult: what integrating a peer's branch did.
 * - GIT_PEER_ROUTES/GIT_PEER_TIP_HEADER/GIT_PEER_NO_BUNDLE_HEADER: daemon HTTP routes, the header naming a sent branch tip
 *   and the marker for a receive without a bundle.
 * - GitPeerHavesRequestSchema, GitPeerBundleRequestSchema, GitPeerReceiveQuerySchema, GitPeerIntegrateRequestSchema,
 *   GitPeerHavesResultSchema, GitPeerReceiveResultSchema: daemon HTTP bodies for one app-relayed transfer.
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

/** `pull` brings the peer's commits into `location`; `send` has the peer pull from `location`. */
export const GitPeerTransferSchema = z.object({
  action: z.enum(["pull", "send"]),
  location: ProjectLocationReferenceSchema,
  peer: GitPeerAddressSchema,
}).strict();
export type GitPeerTransfer = z.infer<typeof GitPeerTransferSchema>;

export const GitPeerIntegrationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({
    kind: z.literal("applied"), mode: z.enum(["fastForward", "replay"]), fromSha: sha, toSha: sha,
    warnings: z.array(z.string().max(512)),
  }).strict(),
  z.object({ kind: z.literal("blocked"), reason: failure, conflicts: z.array(z.string()) }).strict(),
]);
export type GitPeerIntegrationResult = z.infer<typeof GitPeerIntegrationResultSchema>;

export const GIT_PEER_ROUTES = {
  haves: "/daemon/git-peer/haves",
  bundle: "/daemon/git-peer/bundle",
  receive: "/daemon/git-peer/receive",
  integrate: "/daemon/git-peer/integrate",
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
export const GitPeerIntegrateRequestSchema = GitPeerHavesRequestSchema;
