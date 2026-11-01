/*
 * Exports:
 * - MODE_SWITCH_TOOL: the Workbench tool agents switch workflow modes with.
 * - ModeSwitchSchema/ModeSwitch: validate one mode switch request.
 * - ModeGateSchema/ModeGate: one workflow-declared mode entry gate: checklists due since entering any `since` mode.
 * - WorkflowLedgerEntry/readWorkflowLedgerEntry: one successful proof filing or mode switch, read from its tool name and arguments.
 * - readModeSwitch: the mode a successful Workbench mode switch call entered, or null.
 * - evaluateModeGate: whether a chronological ledger lets an agent enter a mode, naming unresolved checklist items.
 * - gatedProofWindows: per gated checklist family, the proofs its gates count.
 */
import { z } from "zod";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import { mergeProofs, ProofFamilySchema, ProofOfWorkSchema, type ProofOfWork, type ProofOfWorkChecklist } from "./proof-of-work.ts";
import type { ThreadItem } from "./workbench-thread-items.ts";

export const MODE_SWITCH_TOOL = "mode_set";
const PROOF_OF_WORK_TOOL = "proof_of_work";

export const ModeSwitchSchema = z.object({ mode: z.string().trim().min(1) }).strict();
export type ModeSwitch = z.infer<typeof ModeSwitchSchema>;

export const ModeGateSchema = z.object({
  mode: z.string().trim().min(1),
  checklists: z.array(ProofFamilySchema).min(1),
  since: z.array(z.string().trim().min(1)),
}).strict();
export type ModeGate = z.infer<typeof ModeGateSchema>;

export type WorkflowLedgerEntry =
  | { readonly kind: "proof"; readonly proof: ProofOfWork }
  | { readonly kind: "mode"; readonly mode: string };

export function readWorkflowLedgerEntry(tool: string, args: unknown): WorkflowLedgerEntry | null {
  if (tool === MODE_SWITCH_TOOL) {
    const parsed = ModeSwitchSchema.safeParse(args);
    return parsed.success ? { kind: "mode", mode: parsed.data.mode } : null;
  }
  if (tool === PROOF_OF_WORK_TOOL) {
    const parsed = ProofOfWorkSchema.safeParse(args);
    return parsed.success ? { kind: "proof", proof: parsed.data } : null;
  }
  return null;
}

export function readModeSwitch(item: ThreadItem) {
  if (item.type !== "mcpToolCall" || (item.server !== "wb" && item.server !== "wbex") || item.tool !== MODE_SWITCH_TOOL) return null;
  if (item.status !== "completed" || item.error) return null;
  const parsed = conformToZodSchema(ModeSwitchSchema, item.arguments);
  return parsed.success && !parsed.discardedPaths.length ? parsed.data.mode : null;
}

function sameMode(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Proofs filed after the latest entry into any `since` mode; with no such entry, every proof in the ledger. */
function proofsSince(ledger: readonly WorkflowLedgerEntry[], since: readonly string[]) {
  let boundary = ledger.length - 1;
  while (boundary >= 0) {
    const entry = ledger[boundary]!;
    if (entry.kind === "mode" && since.some(mode => sameMode(mode, entry.mode))) break;
    boundary -= 1;
  }
  return ledger.slice(boundary + 1).flatMap(entry => entry.kind === "proof" ? [entry.proof] : []);
}

export function evaluateModeGate(
  ledger: readonly WorkflowLedgerEntry[], gates: readonly ModeGate[], catalogue: readonly ProofOfWorkChecklist[], mode: string,
) {
  const gate = gates.find(candidate => sameMode(candidate.mode, mode)) ?? null;
  if (!gate) return { gate, unresolved: [], undeclared: [] };
  const proofs = mergeProofs(proofsSince(ledger, gate.since));
  const declared = new Map(catalogue.map(checklist => [checklist.id, checklist]));
  const unresolved = gate.checklists.flatMap((family) => {
    const ids = declared.get(family)?.items.map(item => item.id)
      .filter(id => { const kind = proofs.get(id)?.kind; return kind !== "answered" && kind !== "notApplicable"; }) ?? [];
    return ids.length ? [{ checklist: family, ids }] : [];
  });
  return { gate, unresolved, undeclared: gate.checklists.filter(family => !declared.has(family)) };
}

/** A family several gates require counts from the latest entry into any of their `since` modes. */
export function gatedProofWindows(ledger: readonly WorkflowLedgerEntry[], gates: readonly ModeGate[]) {
  const since = new Map<string, string[]>();
  for (const gate of gates) for (const family of gate.checklists) since.set(family, [...since.get(family) ?? [], ...gate.since]);
  return new Map([...since].map(([family, modes]) => [family, proofsSince(ledger, modes)]));
}
