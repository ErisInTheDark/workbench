/*
 * Exports:
 * - GitArcAction/GitArcReceipt: describe persisted arc action presentation data. Keywords: git, arc, receipt, thread.
 * - formatGitArcReceipt/parseGitArcReceipt: encode and decode the stable transcript receipt line. Keywords: git, arc, receipt, cli, parser.
 */
import { z } from "zod";

const RECEIPT_PREFIX = "Workbench arc receipt: ";

const GitArcReceiptSchema = z.object({
  action: z.enum(["add", "adopt", "compare", "continue", "diff", "plan", "propose", "remove", "restore", "start"]),
  claimedPaths: z.array(z.string().min(1)),
  intentName: z.string().min(1).nullable(),
  proposalId: z.string().min(1).optional(),
  ref: z.string().regex(/^[a-f0-9]{7,64}$/iu),
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
