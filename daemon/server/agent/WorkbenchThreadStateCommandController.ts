/*
 * Exports:
 * - WorkbenchThreadStateCommandPorts: caller, workflow, process document, turn transcript, title and status ports.
 * - default WorkbenchThreadStateCommandController: answer one thread_state call: file its proofs, refuse its mode or status
 *   without applying anything else, or list process documents, retitle, set status and back documents up on a mode switch;
 *   every answer reports the full state.
 */
import {
  formatProofOfWorkReport, mergeProofs, ProofOfWorkSchema, proofFamily, reconcileProofOfWork,
  type ProofOfWork, type ProofState,
} from "workbench-shared/workbench/thread/proof-of-work";
import {
  describeCompactionRecovery, effectiveWorkflowMode, evaluateThreadStateTransition, gatedProofWindows, MODE_AFTER, readFiledProofs,
  type ThreadState, type WorkflowLedgerEntry, type WorkflowMode,
} from "workbench-shared/workbench/thread/workflow-modes";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { WorkbenchThreadStateRequestSchema } from "../lib/workbench/commands/thread-state-command-definition";
import type { WorkbenchThreadWorkflow } from "../thread/WorkbenchThreadWorkflowReader";

interface WorkbenchThreadStateCaller { cwd: string; harness: string; threadId: string }

export interface WorkbenchThreadStateCommandPorts {
  resolveCaller(caller: WorkbenchThreadStateCaller, signal: AbortSignal): Promise<{ threadId: string }>;
  /** The thread's workflow before this call; its ledger never holds the call being answered. */
  readWorkflow(threadId: string): Promise<WorkbenchThreadWorkflow>;
  /** Throws the owner's explanation when a path cannot stay out of commits; hides the rest and unhides what the list dropped. */
  admitProcessDocuments(caller: WorkbenchThreadStateCaller, paths: readonly string[]): Promise<void>;
  /** The backup commits written; empty when nothing changed. */
  backupProcessDocuments(caller: WorkbenchThreadStateCaller, paths: readonly string[]): Promise<readonly string[]>;
  /** The latest turn's items in transcript order; it may already hold the call being answered. */
  readTurnItems(threadId: string, signal: AbortSignal): Promise<readonly ThreadItem[]>;
  readTitle(caller: { cwd: string; threadId: string }): Promise<string>;
  /** Throws the owner's explanation when the guarded title does not match. */
  setTitle(caller: { cwd: string; threadId: string }, title: string, currentTitle: string | undefined): Promise<void>;
  readStatus(threadId: string): Promise<string>;
  setStatus(caller: { cwd: string; threadId: string }, status: "completed" | "blocked"): Promise<void>;
}

const TEXT_HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };

function text(body: string, status = 200) {
  return new Response(`${body.trimEnd()}\n`, { headers: TEXT_HEADERS, status });
}

const MESSAGE_FIRST = {
  user: "show the user your plan, or what approved work you are resuming, first",
  parent: "brief your parent, or tell it what approved work you are resuming, first",
} as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The message a mode's `after` precondition asks for; null when it has none. */
function messageNeed(mode: WorkflowMode | null) {
  return mode?.after ? MODE_AFTER[mode.after] : null;
}

/** Null when the call files no proof ids; empty buckets file nothing. */
function proofOf({ proofs, notApplicable }: ThreadState) {
  if (!Object.keys(proofs ?? {}).length && !notApplicable?.length) return null;
  return ProofOfWorkSchema.safeParse({ ...proofs ? { proofs } : {}, ...notApplicable ? { notApplicable } : {} });
}

export default class WorkbenchThreadStateCommandController {
  constructor(private readonly ports: WorkbenchThreadStateCommandPorts) {}

  async execute(body: object, signal: AbortSignal) {
    const parsed = WorkbenchThreadStateRequestSchema.safeParse(body);
    if (!parsed.success) return text(`Invalid thread state.\n${this.issues(parsed.error.issues)}`, 400);
    const { state, ...callerInput } = parsed.data;
    const filed = proofOf(state);
    if (filed && !filed.success) return text(`Invalid proofs.\n${this.issues(filed.error.issues)}`, 400);
    const proof = filed?.data ?? null;
    const { threadId } = await this.ports.resolveCaller(callerInput, signal);
    const caller = { cwd: callerInput.cwd, threadId };
    const [workflow, items] = await Promise.all([this.ports.readWorkflow(threadId), this.ports.readTurnItems(threadId, signal)]);
    signal.throwIfAborted();
    const { checklists, modes } = workflow.overlays;

    const unknown = proof ? reconcileProofOfWork(mergeProofs([proof]), checklists).unknownItems : [];
    const ledger: WorkflowLedgerEntry[] = proof ? [...workflow.ledger, { kind: "proof", proof }] : workflow.ledger;
    const transition = evaluateThreadStateTransition(ledger, modes, checklists, state);
    const message = transition.needsMessage ? messageNeed(transition.target) : null;
    if (transition.undeclared.length) console.warn(`[thread-state] ${state.mode} requires undeclared checklists: ${transition.undeclared.join(", ")}.`);
    const refusals = [
      ...unknown.length ? [`Unknown checklist ids: ${unknown.join(", ")}.`] : [],
      ...transition.unknown ? [`Unknown mode "${state.mode}"; declared: ${modes.map(mode => mode.name).join(", ")}.`] : [],
      ...transition.unresolved.length ? [
        `${transition.target!.name} needs checklists filed${transition.target!.resetOn.length ? ` since you last entered ${transition.target!.resetOn.join(" or ")}` : ""}; still unresolved:`,
        ...transition.unresolved.map(({ checklist, ids }) => `- ${checklist}: ${ids.join(", ")}`),
      ] : [],
      ...transition.needsFrom.length
        ? [`${transition.target!.name} is entered only from ${transition.needsFrom.join(" or ")}; current mode: ${transition.current ?? "none"}.`]
        : [],
      ...message && !transition.needsFrom.length
        ? [`${transition.target!.name} needs ${message.label} since you entered ${transition.current ?? "the current mode"}: ${MESSAGE_FIRST[message.audience]}.`]
        : [],
      ...transition.needsStatus ? [`${transition.target!.name} is entered together with status: "${transition.needsStatus}".`] : [],
      ...transition.needsMode.length ? [`Status completed needs mode ${transition.needsMode.join(" or ")} after this call.`] : [],
      ...transition.needsRecovery
        ? [`Context was compacted; ${transition.target!.name} needs ${describeCompactionRecovery(transition.needsRecovery)} first.`]
        : [],
    ];

    let failure: string | null = null;
    if (!refusals.length && state.processDocuments) {
      try { await this.ports.admitProcessDocuments(callerInput, state.processDocuments); }
      catch (error) { failure = `Process documents: ${errorMessage(error)}`; }
    }
    if (!refusals.length && !failure && state.title) {
      try { await this.ports.setTitle(caller, state.title, state.currentTitle); }
      catch (error) { failure = `Title: ${errorMessage(error)}`; }
    }
    const applied = !refusals.length && !failure;
    if (applied && state.status) await this.ports.setStatus(caller, state.status);
    const documents = applied && state.processDocuments ? state.processDocuments : workflow.processDocuments;
    const backup = applied && state.mode ? await this.backup(callerInput, documents) : null;

    const entered = applied && state.mode ? state.mode : workflow.mode;
    const effective = applied && state.mode ? state.mode : effectiveWorkflowMode(workflow.ledger, modes)?.name ?? null;
    const mode = effective ?? entered;
    const shownMode = entered && effective && entered.toLowerCase() === effective.toLowerCase()
      ? entered
      : `${entered ?? "none"}${effective ? `, so ${effective}'s rules apply` : ""}`;
    const [title, status] = await Promise.all([this.ports.readTitle(caller), this.ports.readStatus(threadId)]);
    const report = [
      applied
        ? (state.mode ? `Entered ${state.mode}.` : "Applied.")
        : `Not applied${proof ? "; proofs filed" : ""}:\n${failure ?? refusals.join("\n")}`,
      `Mode: ${shownMode}. Status: ${status}${applied && state.status ? ` (${state.status} applies when the turn ends)` : ""}. Title: ${title || "none"}.`,
      `Process documents: ${documents.length ? documents.join(", ") : "none"}.`,
      ...backup ? [backup] : [],
      ...proof ? [this.proofReport(proof, items, ledger, workflow)] : [],
      ...this.owed(applied && state.mode ? [...ledger, { kind: "mode", mode: state.mode }] : ledger, workflow, mode),
    ];
    return text(report.join("\n"), applied ? 200 : 400);
  }

  /** Backups are a safety net: a failure is reported and never holds up the mode switch that already applied. */
  private async backup(caller: WorkbenchThreadStateCaller, documents: readonly string[]) {
    if (!documents.length) return null;
    try {
      const commits = await this.ports.backupProcessDocuments(caller, documents);
      return commits.length ? "Process documents backed up." : null;
    } catch (error) {
      return `Process document backup failed: ${errorMessage(error)}`;
    }
  }

  private issues(issues: readonly { message: string; path: readonly PropertyKey[] }[]) {
    return issues.slice(0, 5).map(({ message, path }) => `${path.map(String).join(".") || "input"}: ${message}`).join("\n");
  }

  /** Gated checklists report over their modes' windows; others over the current turn, as filed so far. */
  private proofReport(proof: ProofOfWork, items: readonly ThreadItem[], ledger: readonly WorkflowLedgerEntry[], workflow: WorkbenchThreadWorkflow) {
    const { checklists, modes } = workflow.overlays;
    const filed = items.flatMap(item => { const submission = readFiledProofs(item); return submission ? [submission] : []; });
    const turn = mergeProofs([...filed, proof]);
    const touched = new Set([...turn.keys()].map(proofFamily));
    const windows = gatedProofWindows(ledger, modes);
    const proofs = new Map<string, ProofState>([...turn].filter(([id]) => !windows.has(proofFamily(id))));
    for (const [family, window] of windows) {
      if (!touched.has(family)) continue;
      for (const [id, state] of mergeProofs(window)) if (proofFamily(id) === family) proofs.set(id, state);
    }
    return formatProofOfWorkReport(reconcileProofOfWork(proofs, checklists), checklists).trimEnd();
  }

  /** What every other gated mode still needs from here, so the agent can file it or route through its sources first. */
  private owed(ledger: readonly WorkflowLedgerEntry[], workflow: WorkbenchThreadWorkflow, mode: string | null) {
    const { checklists, modes } = workflow.overlays;
    return modes.flatMap((candidate) => {
      if ((!candidate.proofs.length && !candidate.from.length && !candidate.after) || candidate.name.toLowerCase() === mode?.toLowerCase()) return [];
      const { current, needsFrom, needsMessage, needsRecovery, unresolved } = evaluateThreadStateTransition(
        ledger, modes, checklists, { mode: candidate.name, status: candidate.status ?? undefined },
      );
      const message = needsMessage ? messageNeed(candidate) : null;
      const needs = [
        ...needsFrom.length ? [`entering from ${needsFrom.join(" or ")}`] : [],
        ...message && !needsFrom.length ? [`${message.label} since entering ${current ?? "the current mode"}`] : [],
        ...unresolved.map(({ checklist, ids }) => `${checklist} (${ids.join(", ")})`),
        ...needsRecovery ? [`after compaction, ${describeCompactionRecovery(needsRecovery)}`] : [],
      ];
      return needs.length ? [`${candidate.name} needs: ${needs.join("; ")}.`] : [];
    });
  }
}
