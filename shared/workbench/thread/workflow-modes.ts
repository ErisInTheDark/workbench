/*
 * Exports:
 * - THREAD_STATE_TOOL: the Workbench tool agents file proofs, switch modes, retitle and set status with.
 * - ThreadStateSchema/ThreadState: one thread_state call; no fields reads.
 * - ModeIconSchema/ModeIcon: the icons an instruction-declared mode may show beside its name.
 * - MODE_EDIT_DENIALS: deny tokens that restrict file edits rather than tools.
 * - ModeAfterSchema/ModeAfter/MODE_AFTER: the message preconditions a mode may declare, each with its audience and readable label.
 * - WorkflowModeSchema/WorkflowMode: one instruction-declared mode: its icon, colour, proofs due on entry, resets, entry sources, message precondition, status pairing and denials.
 * - WorkflowLedgerSource/WorkflowLedgerEntry/readWorkflowLedgerEntries: what one recorded Workbench call contributed to a thread's workflow;
 *   user-visible agent messages join the ledger as user message entries, successful messages to the parent as parent ones,
 *   completed compactions as compaction entries and unfiltered recalls of the thread's own history as recall entries.
 * - PRE_MODE_TOOLS: the only tools a thread runs before it first enters a declared mode.
 * - COMPACTION_CHECKLIST: the checklist family a compaction needs resolved before edits or checklist-gated modes.
 * - awaitsFirstMode: whether a workflow declaring modes has never entered one.
 * - CompactionRecovery/compactionRecoveryNeeds/describeCompactionRecovery: what the latest compaction still needs, and its readable form.
 * - readThreadStateCall/readModeEntered/readFiledProofs: a transcript call's thread_state arguments, entered mode, and filed proofs.
 * - currentWorkflowMode/currentProcessDocuments: a ledger's latest entered mode and process documents.
 * - effectiveWorkflowMode: the declared mode whose rules apply, falling back to the first declared one.
 * - findWorkflowMode: the definition a mode name selects.
 * - evaluateThreadStateTransition: whether one call may apply its mode and status from the current mode, naming every refusal,
 *   including compaction recovery a checklist-gated target still needs.
 * - gatedProofWindows: per gated checklist family, the proofs its modes count.
 */
import { z } from "zod";
import { readWorkbenchDeferredCall } from "../mcp/mcp-server-settings.ts";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import {
  mergeProofs, ProofFamilySchema, ProofOfWorkBuckets, ProofOfWorkSchema, readProofOfWorkSubmission, withoutRetiredProofFields,
  type ProofOfWork, type ProofOfWorkChecklist,
} from "./proof-of-work.ts";
import type { ThreadItem } from "./workbench-thread-items.ts";

export const THREAD_STATE_TOOL = "thread_state";
const LEGACY_MODE_TOOL = "mode_set";
const LEGACY_PROOF_TOOL = "proof_of_work";
const MESSAGE_AGENT_TOOL = "message_agent";
const RECALL_TOOL = "thread_recall";

export const PRE_MODE_TOOLS: ReadonlySet<string> = new Set([
  THREAD_STATE_TOOL, RECALL_TOOL, "thread_recall_search", "message_user", MESSAGE_AGENT_TOOL,
]);
export const COMPACTION_CHECKLIST = "compaction";

export const ThreadStateSchema = z.object({
  ...ProofOfWorkBuckets,
  mode: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  currentTitle: z.string().min(1).optional().describe("Exact current title when retitling; omit only when no title is set."),
  status: z.enum(["completed", "blocked"]).optional(),
  processDocuments: z.array(z.string().trim().min(1)).optional()
    .describe("Replaces this thread's process documents: exact file paths every mode may edit, hidden from commits and backed up; [] clears them."),
}).strict();
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const ModeIconSchema = z.enum(["search", "clipboard", "pen", "flag"]);
export type ModeIcon = z.infer<typeof ModeIconSchema>;

export const MODE_EDIT_DENIALS = ["edit", "edit:claims"] as const;

export const ModeAfterSchema = z.enum(["message", "parent-message"]);
export type ModeAfter = z.infer<typeof ModeAfterSchema>;
type MessageAudience = "user" | "parent";

export const MODE_AFTER: Record<ModeAfter, { readonly audience: MessageAudience; readonly label: string }> = {
  message: { audience: "user", label: "a user-visible message" },
  "parent-message": { audience: "parent", label: "a message to your parent" },
};

export const WorkflowModeSchema = z.object({
  name: z.string().trim().min(1),
  icon: ModeIconSchema.nullable(),
  /** Any colour a `<color>` tag accepts: a palette word or hex. */
  color: z.string().trim().min(1).nullable(),
  proofs: z.array(ProofFamilySchema),
  resetOn: z.array(z.string().trim().min(1)),
  /** Modes it may be entered from; empty means any. */
  from: z.array(z.string().trim().min(1)),
  /** Entered only after a message to `MODE_AFTER`'s audience since the current mode was entered. */
  after: ModeAfterSchema.nullable(),
  status: z.literal("completed").nullable(),
  deny: z.array(z.string().trim().min(1)),
}).strict();
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export interface WorkflowLedgerSource {
  /** The thread whose ledger holds the call. */
  readonly threadId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly failed: boolean;
}

export type WorkflowLedgerEntry =
  | { readonly kind: "proof"; readonly proof: ProofOfWork }
  | { readonly kind: "mode"; readonly mode: string }
  | { readonly kind: "processDocuments"; readonly paths: readonly string[] }
  | { readonly kind: "message"; readonly audience: MessageAudience }
  | { readonly kind: "compaction" }
  | { readonly kind: "recall" };

const ParentMessageSchema = z.object({ parent: z.literal(true) }).passthrough();
const RecallSchema = z.object({ threadId: z.string().optional(), kinds: z.array(z.string()).optional(), turn: z.string().optional() }).passthrough();

function proofOf(state: ThreadState): ProofOfWork | null {
  const parsed = ProofOfWorkSchema.safeParse({
    ...(state.proofs ? { proofs: state.proofs } : {}),
    ...(state.notApplicable ? { notApplicable: state.notApplicable } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Recorded calls predate retired fields; the schema is strict, so an unmapped one would lose the whole call and its proofs. */
function currentThreadStateArgs(args: unknown) {
  const current = withoutRetiredProofFields(args);
  if (current === null || typeof current !== "object" || !("alwaysEditable" in current)) return current;
  const { alwaysEditable, ...rest } = current as Record<string, unknown>;
  return { ...rest, processDocuments: alwaysEditable };
}

/** A refused thread_state call still files its proofs; its other changes never applied. Legacy calls count only on success. */
export function readWorkflowLedgerEntries({ threadId, tool, args, failed }: WorkflowLedgerSource): WorkflowLedgerEntry[] {
  const deferred = readWorkbenchDeferredCall(tool, args);
  if (deferred) return readWorkflowLedgerEntries({ threadId, tool: deferred.tool, args: deferred.arguments, failed });
  if (tool === THREAD_STATE_TOOL) {
    const parsed = ThreadStateSchema.safeParse(currentThreadStateArgs(args));
    if (!parsed.success) return [];
    const proof = proofOf(parsed.data);
    const entries: WorkflowLedgerEntry[] = proof ? [{ kind: "proof", proof }] : [];
    if (failed) return entries;
    if (parsed.data.processDocuments) entries.push({ kind: "processDocuments", paths: parsed.data.processDocuments });
    if (parsed.data.mode) entries.push({ kind: "mode", mode: parsed.data.mode });
    return entries;
  }
  if (failed) return [];
  if (tool === MESSAGE_AGENT_TOOL) return ParentMessageSchema.safeParse(args).success ? [{ kind: "message", audience: "parent" }] : [];
  if (tool === RECALL_TOOL) {
    const parsed = RecallSchema.safeParse(args);
    if (!parsed.success || parsed.data.kinds?.length || parsed.data.turn) return [];
    return !parsed.data.threadId || parsed.data.threadId === threadId ? [{ kind: "recall" }] : [];
  }
  if (tool === LEGACY_MODE_TOOL) {
    const parsed = z.object({ mode: z.string().trim().min(1) }).strict().safeParse(args);
    return parsed.success ? [{ kind: "mode", mode: parsed.data.mode }] : [];
  }
  if (tool === LEGACY_PROOF_TOOL) {
    const parsed = ProofOfWorkSchema.safeParse(withoutRetiredProofFields(args));
    return parsed.success ? [{ kind: "proof", proof: parsed.data }] : [];
  }
  return [];
}

function isWorkbenchCall(item: ThreadItem, tool: string): item is Extract<ThreadItem, { type: "mcpToolCall" }> {
  return item.type === "mcpToolCall" && (item.server === "wb" || item.server === "wbex") && item.tool === tool;
}

/** The thread_state arguments an item carries, directly or through `mcp_call`; undefined for other items. */
function threadStateArgs(item: ThreadItem): unknown {
  if (item.type !== "mcpToolCall" || (item.server !== "wb" && item.server !== "wbex")) return undefined;
  if (item.tool === THREAD_STATE_TOOL) return item.arguments;
  const deferred = readWorkbenchDeferredCall(item.tool, item.arguments);
  return deferred?.tool === THREAD_STATE_TOOL ? deferred.arguments : undefined;
}

/** A thread_state call's arguments and whether it applied; null for other items and unreadable arguments. */
export function readThreadStateCall(item: ThreadItem) {
  const args = threadStateArgs(item);
  if (args === undefined || item.type !== "mcpToolCall") return null;
  const parsed = conformToZodSchema(ThreadStateSchema, currentThreadStateArgs(args));
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

export function awaitsFirstMode(ledger: readonly WorkflowLedgerEntry[], modes: readonly WorkflowMode[]) {
  return modes.length > 0 && currentWorkflowMode(ledger) === null;
}

export interface CompactionRecovery {
  /** No unfiltered recall of the thread's own history followed the compaction. */
  readonly recall: boolean;
  /** Declared compaction checklist items not answered since the compaction. */
  readonly proofs: readonly string[];
}

/** Null when the thread never compacted or has recovered since its latest compaction; not-applicable never resolves an item. */
export function compactionRecoveryNeeds(
  ledger: readonly WorkflowLedgerEntry[], catalogue: readonly ProofOfWorkChecklist[],
): CompactionRecovery | null {
  let boundary = ledger.length - 1;
  while (boundary >= 0 && ledger[boundary]!.kind !== "compaction") boundary -= 1;
  if (boundary < 0) return null;
  const after = ledger.slice(boundary + 1);
  const recall = !after.some(entry => entry.kind === "recall");
  const filed = mergeProofs(after.flatMap(entry => entry.kind === "proof" ? [entry.proof] : []));
  const proofs = catalogue.find(checklist => checklist.id === COMPACTION_CHECKLIST)?.items
    .map(item => item.id).filter(id => filed.get(id)?.kind !== "answered") ?? [];
  return recall || proofs.length ? { recall, proofs } : null;
}

export function describeCompactionRecovery({ recall, proofs }: CompactionRecovery) {
  return [
    recall ? `an unfiltered ${RECALL_TOOL} of this thread` : "",
    proofs.length ? `the ${COMPACTION_CHECKLIST} checklist (${proofs.join(", ")})` : "",
  ].filter(Boolean).join(" and ");
}

export function currentProcessDocuments(ledger: readonly WorkflowLedgerEntry[]): readonly string[] {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (entry.kind === "processDocuments") return entry.paths;
  }
  return [];
}

function messagedSinceModeEntry(ledger: readonly WorkflowLedgerEntry[], audience: MessageAudience) {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (entry.kind === "message" && entry.audience === audience) return true;
    if (entry.kind === "mode") return false;
  }
  return false;
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
 * resolved, when it lists `from` modes, the effective mode among them, and with `after`, a message to that audience
 * since the latest mode entry; a mode paired with `completed` is entered only with that status, and while
 * any mode is paired, `completed` needs one of them after the call. After a compaction, modes requiring checklists
 * also need its recovery.
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
  const message = target?.after ? MODE_AFTER[target.after] : null;
  const needsMessage = message !== null && !messagedSinceModeEntry(ledger, message.audience);
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
    needsMessage,
    needsStatus: needsStatus?.status ?? null,
    needsMode,
    needsRecovery: target?.proofs.length ? compactionRecoveryNeeds(ledger, catalogue) : null,
  };
}

/** A family several modes require counts from the latest entry into any of their reset modes. */
export function gatedProofWindows(ledger: readonly WorkflowLedgerEntry[], modes: readonly WorkflowMode[]) {
  const resets = new Map<string, string[]>();
  for (const mode of modes) for (const family of mode.proofs) resets.set(family, [...resets.get(family) ?? [], ...mode.resetOn]);
  return new Map([...resets].map(([family, resetOn]) => [family, proofsSinceReset(ledger, resetOn)]));
}
