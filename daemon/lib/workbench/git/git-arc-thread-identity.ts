/*
 * Exports:
 * - GitArcResolvedThreadIdentity: canonical owner plus current provider compatibility address.
 * - GitArcThreadIdentityResolver: resolve one stored or incoming Git arc owner at a repository boundary.
 * - passthroughGitArcThreadIdentityResolver: low-level default treating supplied IDs as canonical.
 * - gitArcThreadStorageIds: ordered canonical-first read addresses.
 */
export interface GitArcResolvedThreadIdentity {
  nativeThreadId: string;
  threadId: string;
}

export type GitArcThreadIdentityResolver = (input: {
  harness: string;
  repositoryRoot: string;
  threadId: string;
}) => Promise<GitArcResolvedThreadIdentity | null>;

export const passthroughGitArcThreadIdentityResolver: GitArcThreadIdentityResolver = async ({ threadId }) => ({
  nativeThreadId: threadId,
  threadId,
});

export function gitArcThreadStorageIds(identity: GitArcResolvedThreadIdentity) {
  return identity.nativeThreadId === identity.threadId
    ? [identity.threadId]
    : [identity.threadId, identity.nativeThreadId];
}
