/*
 * Exports:
 * - ApprovalReviewerIdSchema/ApprovalReviewerId: registered auto-approve reviewer identities.
 * - ApprovalReviewerCredential: where a reviewer's credential comes from.
 * - ApprovalReviewerDefinition: endpoint, model and credential source for one reviewer.
 * - APPROVAL_REVIEWERS: registry of auto-approve reviewers; add endpoints here.
 */
import { z } from "zod";

export const ApprovalReviewerIdSchema = z.enum(["typesafe-jev", "zen-jev", "codex-auto-review"]);
export type ApprovalReviewerId = z.infer<typeof ApprovalReviewerIdSchema>;

/** `workbench-secret`: key stored encrypted by Workbench. Others reuse an installed provider's own login. */
export type ApprovalReviewerCredential = "workbench-secret" | "opencode-auth" | "codex-login";

interface ReviewerBase {
  label: string;
  description: string;
  credential: ApprovalReviewerCredential;
}

export type ApprovalReviewerDefinition =
  | ReviewerBase & { transport: "systemone"; url: string; model: string; credential: "workbench-secret" | "opencode-auth" }
  | ReviewerBase & { transport: "codex"; model: string; credential: "codex-login" };

export const APPROVAL_REVIEWERS = {
  "typesafe-jev": {
    label: "Jev via TypeSafe",
    description: "Fast structured judgement from TypeSafe AI.",
    transport: "systemone",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    credential: "workbench-secret",
  },
  "zen-jev": {
    label: "Jev via OpenCode Zen",
    description: "The same Jev model through OpenCode Zen.",
    transport: "systemone",
    url: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13",
    credential: "opencode-auth",
  },
  "codex-auto-review": {
    label: "Codex auto-review",
    description: "Codex's own approval review model. Slower, and uses Codex usage.",
    transport: "codex",
    model: "codex-auto-review",
    credential: "codex-login",
  },
} as const satisfies Record<ApprovalReviewerId, ApprovalReviewerDefinition>;
