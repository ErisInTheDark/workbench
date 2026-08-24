/*
 * Exports:
 * - GitArcAction/GitArcReceipt: describe persisted arc action presentation data. Keywords: git, arc, receipt, thread.
 * - formatGitArcReceipt/parseGitArcReceipt: encode and decode the stable transcript receipt line. Keywords: git, arc, receipt, cli, parser.
 */
import { z } from "zod";

import { ORCHESTRATOR_RELOAD_SCOPES } from "../orchestrator-reload";

const RECEIPT_PREFIX = "Workbench arc receipt: ";

const GitArcReceiptSchema = z.object({
  action: z.enum(["add", "adopt", "compare", "continue", "diff", "mv", "plan", "propose", "remove", "restore", "start"]),
  additionalClaims: z.array(z.string().min(1)).optional(),
  claimedPaths: z.array(z.string().min(1)),
  intentName: z.string().min(1).nullable(),
  memberRefs: z.array(z.object({ ref: z.string().regex(/^[a-f0-9]{7,64}$/iu), rootId: z.string().min(1) }).strict()).optional(),
  proposalId: z.string().min(1).optional(),
  rootId: z.string().min(1).optional(),
  reloadScopes: z.array(z.enum(ORCHESTRATOR_RELOAD_SCOPES)).optional(),
  ref: z.string().regex(/^[a-f0-9]{7,64}$/iu),
  matchedPathCount: z.number().int().nonnegative().optional(),
  mappings: z.array(z.object({ destination: z.string().min(1), source: z.string().min(1) })).optional(),
  mode: z.enum(["applied", "preview"]).optional(),
  remainingMatchCount: z.number().int().nonnegative().optional(),
  selectedPaths: z.array(z.string().min(1)).optional(),
  version: z.literal(1),
});

export type GitArcAction = z.infer<typeof GitArcReceiptSchema>["action"];
export type GitArcReceipt = z.infer<typeof GitArcReceiptSchema>;

export function formatGitArcReceipt(receipt: GitArcReceipt) {
  return `${RECEIPT_PREFIX}${JSON.stringify(GitArcReceiptSchema.parse(receipt))}`;
}

export function parseGitArcReceipt(output: string) {
  const line = String(output ?? "").split(/\r?\n/u).find((candidate) => candidate.startsWith(RECEIPT_PREFIX));
  if (!line) return null;
  try {
    const parsed = GitArcReceiptSchema.safeParse(JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
