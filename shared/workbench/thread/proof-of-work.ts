/*
 * Exports:
 * - ProofIdSchema/ProofFamilySchema: validate `family.item` proof ids and checklist family ids.
 * - ProofOfWorkSchema/ProofOfWork: validate one submission of answered, not-applicable and deferred ids.
 * - ProofOfWorkChecklistSchema/ProofOfWorkChecklist: one instruction-declared checklist and its items.
 * - readProofOfWorkSubmission: the submission a successful Workbench proof-of-work tool call filed, or null.
 * - ProofState: an id's latest filed state.
 * - mergeProofs: replay submissions so each id keeps its latest state.
 * - reconcileProofOfWork: compare merged proofs with declared checklists, reporting deferred, missing and unknown ids.
 * - presentProofOfWork: group merged proofs for display, leaving out hidden checklists.
 * - proofFamily/formatProofId/proofFamilies: read families and readable labels from ids.
 */
import { z } from "zod";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import type { ThreadItem } from "./workbench-thread-items.ts";

export const ProofFamilySchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);
export const ProofIdSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u);

export const ProofOfWorkSchema = z.object({
  proofs: z.record(ProofIdSchema, z.string().refine(value => value.trim().length > 0, "Answers must not be blank.")).optional(),
  notApplicable: z.array(ProofIdSchema).optional(),
  defer: z.array(ProofIdSchema).optional(),
}).strict().superRefine((value, context) => {
  const buckets = [Object.keys(value.proofs ?? {}), [...new Set(value.notApplicable)], [...new Set(value.defer)]];
  const ids = buckets.flat();
  if (!ids.length) context.addIssue({ code: "custom", message: "File at least one proof id." });
  const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (repeated.length) context.addIssue({ code: "custom", message: `Each id belongs in one bucket: ${repeated.join(", ")}.` });
});
export type ProofOfWork = z.infer<typeof ProofOfWorkSchema>;

export const ProofOfWorkChecklistSchema = z.object({
  id: ProofFamilySchema,
  hidden: z.boolean(),
  items: z.array(z.object({ id: ProofIdSchema, label: z.string() }).strict()),
}).strict();
export type ProofOfWorkChecklist = z.infer<typeof ProofOfWorkChecklistSchema>;

export function readProofOfWorkSubmission(item: ThreadItem) {
  if (item.type !== "mcpToolCall" || (item.server !== "wb" && item.server !== "wbex") || item.tool !== "proof_of_work") return null;
  if (item.status === "failed" || item.error) return null;
  const parsed = conformToZodSchema(ProofOfWorkSchema, item.arguments);
  return parsed.success && !parsed.discardedPaths.length ? parsed.data : null;
}

export type ProofState =
  | { readonly kind: "answered"; readonly answer: string }
  | { readonly kind: "notApplicable" }
  | { readonly kind: "deferred" };

export function mergeProofs(submissions: readonly ProofOfWork[]) {
  const merged = new Map<string, ProofState>();
  for (const submission of submissions) {
    for (const [id, answer] of Object.entries(submission.proofs ?? {})) merged.set(id, { kind: "answered", answer });
    for (const id of submission.notApplicable ?? []) merged.set(id, { kind: "notApplicable" });
    for (const id of submission.defer ?? []) merged.set(id, { kind: "deferred" });
  }
  return merged;
}

export function proofFamily(id: string) {
  return id.split(".")[0] ?? id;
}

/** Only families the proofs touch are reported; unknown ids are those a declared family does not list. */
export function reconcileProofOfWork(proofs: ReadonlyMap<string, ProofState>, checklists: readonly ProofOfWorkChecklist[]) {
  const touched = new Set([...proofs.keys()].map(proofFamily));
  const declared = new Map(checklists.map(checklist => [checklist.id, checklist]));
  const reports = [...touched].flatMap((family) => {
    const checklist = declared.get(family);
    if (!checklist) return [];
    const itemIds = checklist.items.map(item => item.id);
    return [{
      checklist,
      resolved: itemIds.filter(id => { const kind = proofs.get(id)?.kind; return kind === "answered" || kind === "notApplicable"; }).length,
      deferred: itemIds.filter(id => proofs.get(id)?.kind === "deferred"),
      missing: itemIds.filter(id => !proofs.has(id)),
    }];
  });
  return {
    checklists: reports,
    unknownFamilies: [...touched].filter(family => !declared.has(family)),
    unknownItems: [...proofs.keys()].filter(id => declared.get(proofFamily(id))?.items.every(item => item.id !== id) ?? false),
  };
}

/** Drops hidden checklists' ids; labels come from the declaring checklist, else from the id. */
export function presentProofOfWork(proofs: ReadonlyMap<string, ProofState>, checklists: readonly ProofOfWorkChecklist[]) {
  const declared = new Map(checklists.map(checklist => [checklist.id, checklist]));
  const visible = [...proofs].filter(([id]) => !declared.get(proofFamily(id))?.hidden).map(([id, state]) => ({
    id,
    label: declared.get(proofFamily(id))?.items.find(item => item.id === id)?.label ?? formatProofId(id),
    state,
  }));
  return {
    families: proofFamilies(visible.map(entry => entry.id)),
    answered: visible.flatMap(entry => entry.state.kind === "answered" ? [{ ...entry, answer: entry.state.answer }] : []),
    notApplicable: visible.filter(entry => entry.state.kind === "notApplicable"),
    deferred: visible.filter(entry => entry.state.kind === "deferred"),
  };
}

function sentenceCase(part: string) {
  const words = part.replace(/_/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatProofId(id: string) {
  return sentenceCase(id.split(".")[1] ?? id);
}

export function proofFamilies(ids: Iterable<string>) {
  return [...new Set([...ids].map(id => sentenceCase(proofFamily(id))))];
}
