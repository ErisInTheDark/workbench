/*
 * Exports:
 * - ProofOfWorkSchema/ProofOfWork: validate one checklist submission.
 * - mergeProofs: combine submissions with the latest answer for each id.
 * - countProofs: count answered and not-applicable items.
 * - formatProofId/proofFamilies/isNotApplicable: prepare readable labels and classify answers.
 */
import { z } from "zod";

const proofId = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u);
export const ProofOfWorkSchema = z.object({
  proofs: z.record(proofId, z.string().refine(value => value.trim().length > 0))
    .refine(value => Object.keys(value).length > 0),
}).strict();
export type ProofOfWork = z.infer<typeof ProofOfWorkSchema>;

export function mergeProofs(submissions: readonly Readonly<Record<string, string>>[]) {
  return Object.assign({}, ...submissions) as Record<string, string>;
}

export function isNotApplicable(answer: string) {
  return answer.trim().toLowerCase() === "not applicable";
}

function sentenceCase(part: string) {
  const words = part.replace(/_/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatProofId(id: string) {
  return sentenceCase(id.split(".")[1] ?? id);
}

export function proofFamilies(proofs: Readonly<Record<string, string>>) {
  return [...new Set(Object.keys(proofs).map(id => sentenceCase(id.split(".")[0] ?? "")))];
}

export function countProofs(proofs: Readonly<Record<string, string>>) {
  let notApplicable = 0;
  for (const answer of Object.values(proofs)) {
    if (isNotApplicable(answer)) notApplicable++;
  }
  return { answered: Object.keys(proofs).length - notApplicable, notApplicable };
}
