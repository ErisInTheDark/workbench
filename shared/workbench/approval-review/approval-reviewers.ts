/*
 * Exports:
 * - ApprovalReviewerIdSchema/ApprovalReviewerId: registered auto-approve reviewer identities.
 * - ApprovalReviewerCredential: where a reviewer's credential comes from.
 * - ApprovalReviewerModel: fixed model id, or a catalogue lookup for models whose ids change.
 * - ApprovalReviewerDefinition: endpoint, model and credential source for one reviewer.
 * - APPROVAL_REVIEWERS: registry of auto-approve reviewers; add endpoints here.
 */
import { z } from "zod";

export const ApprovalReviewerIdSchema = z.enum(["typesafe-jev", "zen-jev", "zen-jev-free", "codex-auto-review"]);
export type ApprovalReviewerId = z.infer<typeof ApprovalReviewerIdSchema>;

/**
 * `workbench-secret`: key stored encrypted by Workbench.
 * `opencode-auth`: the OpenCode Zen login. `opencode-public`: the Zen login when present, else Zen's anonymous free tier.
 * `codex-login`: the installed Codex provider's ChatGPT login.
 */
export type ApprovalReviewerCredential = "workbench-secret" | "opencode-auth" | "opencode-public" | "codex-login";

/** A catalogue lookup picks the first listed model id matching `pattern`; the reviewer is unavailable when none does. */
export type ApprovalReviewerModel = string | { catalogue: string; pattern: RegExp };

export type ApprovalReviewerDefinition =
  | { label: string; transport: "systemone"; url: string; model: ApprovalReviewerModel; credential: "workbench-secret" | "opencode-auth" | "opencode-public" }
  | { label: string; transport: "codex"; model: string; credential: "codex-login" };

export const APPROVAL_REVIEWERS = {
  "typesafe-jev": {
    label: "Jev via TypeSafe",
    transport: "systemone",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    credential: "workbench-secret",
  },
  "zen-jev": {
    label: "Jev via OpenCode Zen",
    transport: "systemone",
    url: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13",
    credential: "opencode-auth",
  },
  "zen-jev-free": {
    label: "Jev free via OpenCode Zen",
    transport: "systemone",
    url: "https://opencode.ai/zen/v1/systemone",
    model: { catalogue: "https://opencode.ai/zen/v1/models", pattern: /^jev(?:-.*)?-free$/u },
    credential: "opencode-public",
  },
  "codex-auto-review": {
    label: "Codex auto-review",
    transport: "codex",
    model: "codex-auto-review",
    credential: "codex-login",
  },
} as const satisfies Record<ApprovalReviewerId, ApprovalReviewerDefinition>;
