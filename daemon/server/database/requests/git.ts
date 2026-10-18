/*
 * Exports:
 * - gitRequests: database requests for thread Git selections, legacy diff artifacts and the Git arc proposal diff cache.
 */
import type { GitArcProposalDiffCacheIdentity, GitArcProposalDiffCacheValue } from "../../lib/workbench/git/GitArcProposalDiffController.ts";
import WorkbenchLegacyDiffArtifactStore, { type LegacyDiffArtifactReference } from "../git/WorkbenchLegacyDiffArtifactStore.ts";
import WorkbenchThreadGitSelectionStore, { type ThreadGitSelectionCommand } from "../git/WorkbenchThreadGitSelectionStore.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

export const gitRequests = {
  executeThreadGitSelection: defineDatabaseRequest({
    run: ({ database }, command: ThreadGitSelectionCommand) => new WorkbenchThreadGitSelectionStore(database).execute(command),
  }),
  readLegacyDiffArtifact: defineDatabaseRequest({
    read: "core",
    run: ({ database }, input: LegacyDiffArtifactReference) => new WorkbenchLegacyDiffArtifactStore(database).read(input),
  }),
  // Reads touch cache recency, so they run on the writer.
  readGitArcProposalDiff: defineDatabaseRequest({
    run: ({ proposalDiffs }, identity: GitArcProposalDiffCacheIdentity) => proposalDiffs.read(identity),
  }),
  writeGitArcProposalDiff: defineDatabaseRequest({
    run: ({ proposalDiffs }, value: GitArcProposalDiffCacheValue, maxBytes: number) => { proposalDiffs.write(value, maxBytes); },
  }),
};
