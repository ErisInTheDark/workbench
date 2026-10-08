/*
 * Exports:
 * - WORKBENCH_GIT_ARC_RESULT_SCHEMAS: the one result contract per browser Git arc method, shared by daemon dispatch and the browser client.
 */
import { z } from "zod";

import {
  GitArcProposalCommitManyResultSchema,
  GitArcStashResultSchema,
  GitCheckpointCompareResultSchema,
  GitCheckpointProposalSchema,
} from "../git/checkpoint-contracts.ts";
import type { WorkbenchDaemonGitArcMethod, WorkbenchDaemonResult } from "./workbench-daemon-requests.ts";

const acknowledged = z.object({ ok: z.literal(true) }).strict();

/** Keyed by every method, so adding a Git arc method without its result contract fails to typecheck. */
export const WORKBENCH_GIT_ARC_RESULT_SCHEMAS = {
  "git/arc/compare": GitCheckpointCompareResultSchema,
  "git/arc/diff-artifact/read": z.string(),
  "git/arc/proposal/commit": GitCheckpointProposalSchema,
  "git/arc/proposals/commit": GitArcProposalCommitManyResultSchema,
  "git/arc/proposal/read": GitCheckpointProposalSchema,
  "git/arc/release": acknowledged,
  "git/arc/remove": acknowledged,
  "git/arc/restore": acknowledged,
  "git/arc/stash": GitArcStashResultSchema,
  "git/arc/unstash": GitArcStashResultSchema,
  "git/arc/stash/discard": acknowledged,
} as const satisfies { [Method in WorkbenchDaemonGitArcMethod]: z.ZodType<WorkbenchDaemonResult<Method>> };
