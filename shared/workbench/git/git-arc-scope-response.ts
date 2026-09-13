/*
 * Exports:
 * - GitArcRepositoryScopeSchema/GitArcRepositoryScope: repository-relative live claims.
 * - GitArcScopeClaimsResponseSchema: decode single-repository and workspace scope responses.
 */
import { z } from "zod";

export const GitArcRepositoryScopeSchema = z.object({
  repoRoot: z.string().min(1),
  claimedPaths: z.array(z.string().min(1)),
});
export type GitArcRepositoryScope = z.infer<typeof GitArcRepositoryScopeSchema>;

export const GitArcScopeClaimsResponseSchema = z.union([
  z.object({ repositoryScopes: z.array(GitArcRepositoryScopeSchema) }).transform(value => value.repositoryScopes),
  GitArcRepositoryScopeSchema.extend({
    // Old workspace output qualifies these paths, so it cannot be read as a single repository.
    members: z.never().optional(),
  }).transform(value => [{ repoRoot: value.repoRoot, claimedPaths: value.claimedPaths }]),
  z.null().transform(() => [] as GitArcRepositoryScope[]),
]);
