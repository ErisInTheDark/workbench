/*
 * Exports:
 * - THREAD_STATE_TOOL: the Workbench tool agents file proofs, switch modes, retitle and set status with.
 * - ThreadStateSchema/ThreadState: one thread_state call; no fields reads.
 * - ModeIconSchema/ModeIcon: the icons an instruction-declared mode may show beside its name.
 * - MODE_EDIT_DENIALS: deny tokens that restrict file edits rather than tools.
 * - WorkflowModeSchema/WorkflowMode: one instruction-declared mode: its icon, colour, proofs due on entry, resets, entry sources, status pairing and denials.
 * - WorkflowLedgerSource/WorkflowLedgerEntry/readWorkflowLedgerEntries: what one recorded Workbench call contributed to a thread's workflow.
 * - readThreadStateCall/readModeEntered/readFiledProofs: a transcript call's thread_state arguments, entered mode, and filed proofs.
 * - currentWorkflowMode/currentAlwaysEditable: a ledger's latest entered mode and always-editable paths.
 * - effectiveWorkflowMode: the declared mode whose rules apply, falling back to the first declared one.
 * - findWorkflowMode: the definition a mode name selects.
 * - evaluateThreadStateTransition: whether one call may apply its mode and status from the current mode, naming every refusal.
 * - gatedProofWindows: per gated checklist family, the proofs its modes count.
 */
import { z } from "zod";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import {
  mergeProofs, ProofFamilySchema, ProofOfWorkBuckets, ProofOfWorkSchema, readProofOfWorkSubmission,
  type ProofOfWork, type ProofOfWorkChecklist,
} from "./proof-of-work.ts";
import type { ThreadItem } from "./workbench-thread-items.ts";

export const THREAD_STATE_TOOL = "thread_state";
const LEGACY_MODE_TOOL = "mode_set";
const LEGACY_PROOF_TOOL = "proof_of_work";

export const ThreadStateSchema = z.object({
  ...ProofOfWorkBuckets,
  mode: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  currentTitle: z.string().min(1).optional().describe("Exact current title when retitling; omit only when no title is set."),
  status: z.enum(["completed", "blocked"]).optional(),
  alwaysEditable: z.array(z.string().trim().min(1)).optional()
    .describe("Replaces the paths every mode may edit; [] clears it."),
}).strict();
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const ModeIconSchema = z.enum(["search", "clipboard", "pen", "flag"]);
export type ModeIcon = z.infer<typeof ModeIconSchema>;

export const MODE_EDIT_DENIALS = ["edit", "edit:claims"] as const;

export const WorkflowModeSchema = z.object({
  name: z.string().trim().min(1),
  icon: ModeIconSchema.nullable(),
  /** Any colour a `<color>` tag accepts: a palette word or hex. */
  color: z.string().trim().min(1).nullable(),
  proofs: z.array(ProofFamilySchema),
  resetOn: z.array(z.string().trim().min(1)),
  /** Modes it may be entered from; empty means any. */
  from: z.array(z.string().trim().min(1)),
  status: z.literal("completed").nullable(),
  deny: z.array(z.string().trim().min(1)),
}).strict();
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export interface WorkflowLedgerSource {
  readonly tool: string;
  readonly args: unknown;
  readonly failed: boolean;
}

export type WorkflowLedgerEntry =
  | { readonly kind: "proof"; readonly proof: ProofOfWork }
  | { readonly kind: "mode"; readonly mode: string }
  | { readonly kind: "editable"; readonly paths: readonly string[] };

function proofOf(state: ThreadState): ProofOfWork | null {
  const parsed = ProofOfWorkSchema.safeParse({
    ...(state.proofs ? { proofs: state.proofs } : {}),
    ...(state.notApplicable ? { notApplicable: state.notApplicable } : {}),
    ...(state.defer ? { defer: state.defer } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** A refused thread_state call still files its proofs; its other changes never applied. Legacy calls count only on success. */
export function readWorkflowLedgerEntries({ tool, args, failed }: WorkflowLedgerSource): WorkflowLedgerEntry[] {
  if (tool === THREAD_STATE_TOOL) {
    const parsed = ThreadStateSchema.safeParse(args);
    if (!parsed.success) return [];
    const proof = proofOf(parsed.data);
    const entries: WorkflowLedgerEntry[] = proof ? [{ kind: "proof", proof }] : [];
    if (failed) return entries;
    if (parsed.data.alwaysEditable) entries.push({ kind: "editable", paths: parsed.data.alwaysEditable });
    if (parsed.data.mode) entries.push({ kind: "mode", mode: parsed.data.mode });
    return entries;
  }
  if (failed) return [];
  if (tool === LEGACY_MODE_TOOL) {
    const parsed = z.object({ mode: z.string().trim().min(1) }).strict().safeParse(args);
    return parsed.success ? [{ kind: "mode", mode: parsed.data.mode }] : [];
  }
  if (tool === LEGACY_PROOF_TOOL) {
    const parsed = ProofOfWorkSchema.safeParse(args);
    return parsed.success ? [{ kind: "proof", proof: parsed.data }] : [];
  }
  return [];
}

function isWorkbenchCall(item: ThreadItem, tool: string): item is Extract<ThreadItem, { type: "mcpToolCall" }> {
  return item.type === "mcpToolCall" && (item.server === "wb" || item.server === "wbex") && item.tool === tool;
}

/** A thread_state call's arguments and whether it applied; null for other items and unreadable arguments. */
export function readThreadStateCall(item: ThreadItem) {
  if (!isWorkbenchCall(item, THREAD_STATE_TOOL)) return null;
  const parsed = conformToZodSchema(ThreadStateSchema, item.arguments);
  if (!parsed.success || parsed.discardedPaths.length) return null;
  return { state: parsed.data, applied: item.status === "completed" && !item.error, settled: item.status !== "inProgress" };
}

/** The mode a successful thread_state or legacy mode_set call entered, or null. */
export function readModeEntered(item: ThreadItem) {
  const call = readThreadStateCall(item);
  if (call) return call.applied ? call.state.mode ?? null : null;
  if (!isWorkbenchCall(item, LEGACY_MODE_TOOL) || item.status !== "completed" || item.error) return null;
  const parsed = conformToZodSchema(z.object({ mode: z.string().trim().min(1) }).strict(), item.arguments);
  return parsed.success && !parsed.discardedPaths.length ? parsed.data.mode : null;
}

/** Proofs a settled thread_state call filed, refused or not, or a successful legacy proof_of_work call filed. */
export function readFiledProofs(item: ThreadItem) {
  const call = readThreadStateCall(item);
  if (call) return call.settled ? proofOf(call.state) : null;
  return readProofOfWorkSubmission(item);
}

function sameMode(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function findWorkflowMode(modes: readonly WorkflowMode[], name: string | null | undefined) {
  return name ? modes.find(mode => sameMode(mode.name, name)) ?? null : null;
}

export function currentWorkflowMode(ledger: readonly WorkflowLedgerEntry[]) {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (entry.kind === "mode") return entry.mode;
  }
  return null;
}

/** The declared mode whose rules apply: the current one, else the first declared, so skipping or inventing a mode escapes nothing. */
export function effectiveWorkflowMode(ledger: readonly WorkflowLedgerEntry[], modes: readonly WorkflowMode[]) {
  return findWorkflowMode(modes, currentWorkflowMode(ledger)) ?? modes[0] ?? null;
}

export function currentAlwaysEditable(ledger: readonly WorkflowLedgerEntry[]): readonly string[] {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (entry.kind === "editable") return entry.paths;
  }
  return [];
}

/** Proofs filed after the latest entry into any reset mode; with no such entry, every proof in the ledger. */
function proofsSinceReset(ledger: readonly WorkflowLedgerEntry[], resetOn: readonly string[]) {
  let boundary = ledger.length - 1;
  while (boundary >= 0) {
    const entry = ledger[boundary]!;
    if (entry.kind === "mode" && resetOn.some(mode => sameMode(mode, entry.mode))) break;
    boundary -= 1;
  }
  return ledger.slice(boundary + 1).flatMap(entry => entry.kind === "proof" ? [entry.proof] : []);
}

/**
 * `ledger` already holds this call's proofs. Only declared modes can be entered. Entering one needs its proof checklists
 * resolved and, when it lists `from` modes, the effective mode among them; a mode paired with `completed` is entered only with that status, and while
 * any mode is paired, `completed` needs one of them after the call.
 */
export function evaluateThreadStateTransition(
  ledger: readonly WorkflowLedgerEntry[],
  modes: readonly WorkflowMode[],
  catalogue: readonly ProofOfWorkChecklist[],
  call: Pick<ThreadState, "mode" | "status">,
) {
  const target = findWorkflowMode(modes, call.mode);
  const declared = new Map(catalogue.map(checklist => [checklist.id, checklist]));
  const proofs = target ? mergeProofs(proofsSinceReset(ledger, target.resetOn)) : new Map();
  const unresolved = (target?.proofs ?? []).flatMap((family) => {
    const ids = declared.get(family)?.items.map(item => item.id)
      .filter(id => { const kind = proofs.get(id)?.kind; return kind !== "answered" && kind !== "notApplicable"; }) ?? [];
    return ids.length ? [{ checklist: family, ids }] : [];
  });
  const needsStatus = target?.status && call.status !== target.status ? target : null;
  const current = effectiveWorkflowMode(ledger, modes)?.name ?? null;
  const needsFrom = target?.from.length && !target.from.some(mode => current && sameMode(mode, current)) ? target.from : [];
  const paired = modes.filter(mode => mode.status === "completed");
  const after = call.mode ?? currentWorkflowMode(ledger);
  const needsMode = call.status === "completed" && paired.length && !paired.some(mode => after && sameMode(mode.name, after))
    ? paired.map(mode => mode.name)
    : [];
  return {
    target,
    unresolved,
    undeclared: (target?.proofs ?? []).filter(family => !declared.has(family)),
    unknown: Boolean(call.mode && modes.length && !target),
    current,
    needsFrom,
    needsStatus: needsStatus?.status ?? null,
    needsMode,
  };
}

/** A family several modes require counts from the latest entry into any of their reset modes. */
export function gatedProofWindows(ledger: readonly WorkflowLedgerEntry[], modes: readonly WorkflowMode[]) {
  const resets = new Map<string, string[]>();
  for (const mode of modes) for (const family of mode.proofs) resets.set(family, [...resets.get(family) ?? [], ...mode.resetOn]);
  return new Map([...resets].map(([family, resetOn]) => [family, proofsSinceReset(ledger, resetOn)]));
}
