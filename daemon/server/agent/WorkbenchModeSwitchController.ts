/*
 * Exports:
 * - WorkbenchModeSwitchControllerOptions: caller, checklist catalogue, mode gate and workflow ledger ports.
 * - default WorkbenchModeSwitchController: enter a mode, or refuse a gated one while its checklists are unresolved in its window.
 */
import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import { evaluateModeGate, type ModeGate, type WorkflowLedgerEntry } from "workbench-shared/workbench/thread/workflow-modes";
import { WorkbenchModeSwitchRequestSchema } from "../lib/workbench/commands/mode-command-definition";

export interface WorkbenchModeSwitchControllerOptions {
  resolveCaller(caller: { cwd: string; harness: string; threadId: string }, signal: AbortSignal): Promise<{ threadId: string; projectRoot: string | null }>;
  readCatalogue(projectRoot: string | null): Promise<readonly ProofOfWorkChecklist[]>;
  readGates(threadId: string): Promise<readonly ModeGate[]>;
  /** The thread's earlier successful filings and mode switches, oldest first. */
  readLedger(threadId: string): Promise<readonly WorkflowLedgerEntry[]>;
}

const TEXT_HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };

export default class WorkbenchModeSwitchController {
  constructor(private readonly options: WorkbenchModeSwitchControllerOptions) {}

  async execute(body: object, signal: AbortSignal) {
    const parsed = WorkbenchModeSwitchRequestSchema.safeParse(body);
    if (!parsed.success) return new Response("Invalid mode switch: name one mode.\n", { headers: TEXT_HEADERS, status: 400 });
    const { mode, ...caller } = parsed.data;
    const { threadId, projectRoot } = await this.options.resolveCaller(caller, signal);
    const [catalogue, gates, ledger] = await Promise.all([
      this.options.readCatalogue(projectRoot),
      this.options.readGates(threadId),
      this.options.readLedger(threadId),
    ]);
    signal.throwIfAborted();

    const { gate, unresolved, undeclared } = evaluateModeGate(ledger, gates, catalogue, mode);
    if (undeclared.length) console.warn(`[mode-gates] ${mode} requires undeclared checklists: ${undeclared.join(", ")}.`);
    if (!gate || !unresolved.length) return new Response(`Entered ${mode}.\n`, { headers: TEXT_HEADERS });
    return new Response([
      `Not entered ${mode}. It requires checklists filed since you last entered ${gate.since.join(" or ")}; still unresolved:`,
      ...unresolved.map(({ checklist, ids }) => `- ${checklist}: ${ids.join(", ")}`),
      "File each with proof of work as soon as you decide it, in any number of calls, then switch again.",
    ].join("\n") + "\n", { headers: TEXT_HEADERS, status: 400 });
  }
}
