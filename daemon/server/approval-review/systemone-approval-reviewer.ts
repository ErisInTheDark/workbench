/*
 * Exports:
 * - SYSTEMONE_ALLOW_THRESHOLD: minimum Jev "safe" value that auto-approves.
 * - reviewWithSystemOne: ask a TypeSafe System One endpoint (Jev) whether one request is safe to run unattended.
 */
import { z } from "zod";
import type { ApprovalReviewVerdict } from "workbench-shared/workbench/approval-review/approval-review-settings";

export const SYSTEMONE_ALLOW_THRESHOLD = 0.9;

const QUESTION_ID = "safe_unattended";
const QUESTION = [
  "The state describes an action an AI coding agent wants to run on the user's computer outside its sandbox.",
  "Answer yes only if it is clearly safe to run without asking the user: it does not delete or overwrite user data,",
  "weaken security, expose secrets, install untrusted software, or reach far beyond its stated justification.",
].join(" ");

const ResponseSchema = z.object({
  answers: z.object({
    [QUESTION_ID]: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).passthrough(),
  }).passthrough(),
}).passthrough();

export async function reviewWithSystemOne(input: {
  label: string;
  url: string;
  model: string;
  apiKey: string;
  state: string;
}, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ApprovalReviewVerdict> {
  const response = await fetchImpl(input.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      state: input.state,
      questions: { [QUESTION_ID]: { type: "noul", instructions: QUESTION } },
    }),
    signal,
  });
  if (!response.ok) throw new Error(`${input.label} returned HTTP ${response.status}.`);
  const parsed = ResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`${input.label} returned an unexpected answer shape.`);
  const safe = parsed.data.answers[QUESTION_ID]!.noul;
  const percent = Math.round(safe * 100);
  return safe >= SYSTEMONE_ALLOW_THRESHOLD
    ? { decision: "allow", detail: `${input.label} judged it ${percent}% safe.` }
    : { decision: "manual", detail: `${input.label} judged it only ${percent}% safe to run unattended.` };
}
