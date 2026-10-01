/*
 * Exports:
 * - WorkbenchApprovalControllerOptions: lifecycle, presentation, saved-rule, delivery, and outcome ports.
 * - WorkbenchApprovalOpenResult: whether an opened approval was decided automatically, shown, or closed meanwhile.
 * - default WorkbenchApprovalController: own every live approval across providers; transports only adapt native requests and decisions.
 */
import type { WorkbenchHarness, WorkbenchPendingUserInputRequest, WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type {
  WorkbenchApprovalDecision, WorkbenchApprovalOutcome, WorkbenchApprovalOutcomeEntry, WorkbenchApprovalSubject,
} from "workbench-shared/workbench/provider/provider-approval";
import type { WorkbenchTranscriptNotification } from "workbench-shared/workbench/provider/provider-observation";
import {
  WORKBENCH_APPROVAL_ALLOW_ONCE_LABEL,
  WORKBENCH_APPROVAL_ALLOW_SESSION_LABEL,
  WORKBENCH_APPROVAL_DECISION_QUESTION_ID,
  WORKBENCH_APPROVAL_DECLINE_LABEL,
} from "workbench-shared/workbench/thread/thread-user-input-requests";
import type WorkbenchCommandApprovalController from "./WorkbenchCommandApprovalController";
import {
  canonicalApprovalWorkdir, COMMAND_APPROVAL_CONFIRMATION, hasApprovalConfirmation, matchesApprovalPrefix, parseApprovalCommand,
} from "./lib/workbench/command-approval-prefix";
import { getPackageScriptPrefix } from "./lib/workbench/package-script-prefixes";
import { buildWorkbenchApprovalPresentation } from "./lib/workbench/approval-presentation";

type LifecycleEvent =
  | { kind: "pendingInput"; questionnaire: null; requestKey: string; turnId: WorkbenchTurnId | null }
  | { kind: "inputResolved"; requestKey: string; answered?: true };

export interface WorkbenchApprovalControllerOptions {
  broadcast(harness: WorkbenchHarness, notification: WorkbenchTranscriptNotification): void;
  collectAnswerContext(harness: WorkbenchHarness, threadId: WorkbenchThreadId, signal: AbortSignal): Promise<void>;
  commandApprovals: Pick<WorkbenchCommandApprovalController, "match" | "save">;
  deliver(harness: WorkbenchHarness, input: { threadId: WorkbenchThreadId; requestKey: string; decision: WorkbenchApprovalDecision }): Promise<boolean>;
  logError(message: string): void;
  observeLifecycle(harness: WorkbenchHarness, threadId: WorkbenchThreadId, event: LifecycleEvent): Promise<void>;
  recordOutcome(entry: WorkbenchApprovalOutcomeEntry): Promise<void>;
  resolveProject(threadId: WorkbenchThreadId): Promise<ProjectId | null>;
}

export type WorkbenchApprovalOpenResult =
  | { kind: "decided"; decision: WorkbenchApprovalDecision }
  | { kind: "shown" }
  | { kind: "closed" };

type RememberCandidate = { label: string; prefix: string[] };

type PendingApproval = {
  harness: WorkbenchHarness;
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId | null;
  itemId: string | null;
  requestKey: string;
  request: WorkbenchUserInputRequest | null;
  remember: { projectId: ProjectId; workdir: string; candidates: RememberCandidate[] } | null;
  status: "opening" | "shown" | "responding";
};

const key = (harness: WorkbenchHarness, requestKey: string) => `${harness}\0${requestKey}`;

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 300);
}

function displayPrefix(prefix: readonly string[]) {
  return prefix.map(token => /\s/u.test(token) ? JSON.stringify(token) : token).join(" ");
}

export default class WorkbenchApprovalController {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly lifetime = new AbortController();

  constructor(private readonly options: WorkbenchApprovalControllerOptions) {}

  /** Idempotent per (harness, requestKey): transports re-open what they still hold after a reload. */
  async open(input: {
    harness: WorkbenchHarness;
    threadId: WorkbenchThreadId;
    turnId: WorkbenchTurnId | null;
    itemId: string | null;
    requestKey: string;
    subject: WorkbenchApprovalSubject;
    allowSession: boolean;
  }): Promise<WorkbenchApprovalOpenResult> {
    this.lifetime.signal.throwIfAborted();
    const existing = this.pending.get(key(input.harness, input.requestKey));
    if (existing) return { kind: "shown" };
    const entry: PendingApproval = {
      harness: input.harness, threadId: input.threadId, turnId: input.turnId, itemId: input.itemId,
      requestKey: input.requestKey, request: null, remember: null, status: "opening",
    };
    this.pending.set(key(input.harness, input.requestKey), entry);
    const isCurrent = () => this.pending.get(key(input.harness, input.requestKey)) === entry && !this.lifetime.signal.aborted;

    let summary: string | undefined;
    if (input.subject.kind === "command" && input.subject.rememberable) {
      try {
        const automatic = await this.evaluateSavedRules(entry, input.subject);
        if (!isCurrent()) return { kind: "closed" };
        if (automatic) {
          this.pending.delete(key(input.harness, input.requestKey));
          if (automatic.kind === "allowOnce") await this.recordOutcome(entry, "autoApproved");
          return { kind: "decided", decision: automatic };
        }
      } catch (error) {
        if (!isCurrent()) return { kind: "closed" };
        this.options.logError(`Saved command approvals failed: ${sanitize(error)}`);
        entry.remember = null;
        summary = "Saved command approvals are unavailable. Review this request manually.";
      }
    }

    entry.request = buildWorkbenchApprovalPresentation({
      id: `approval:${input.harness}:${input.requestKey}`,
      subject: input.subject,
      allowSession: input.allowSession,
      rememberOptions: entry.remember?.candidates.map(candidate => ({
        label: candidate.label,
        description: `Remember for this project in ${entry.remember!.workdir}. Includes trailing arguments and future script contents; explicit single-command confirmation is required.`,
      })),
      ...(summary ? { summary } : {}),
    });
    entry.status = "shown";
    this.options.broadcast(input.harness, {
      method: "questionnaire/requested",
      params: { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, requestKey: entry.requestKey, request: entry.request },
    });
    await this.observe(entry, { kind: "pendingInput", questionnaire: null, requestKey: entry.requestKey, turnId: entry.turnId });
    return isCurrent() ? { kind: "shown" } : { kind: "closed" };
  }

  /** The transport's native request went away (turn ended, tool aborted, upstream reset). */
  close(harness: WorkbenchHarness, requestKey: string) {
    const entry = this.pending.get(key(harness, requestKey));
    if (!entry) return;
    this.pending.delete(key(harness, requestKey));
    if (entry.status === "opening") return;
    this.resolveVisibly(entry, false);
  }

  owns(threadId: string, requestKey: string) {
    return [...this.pending.values()].some(entry => entry.threadId === threadId && entry.requestKey === requestKey);
  }

  list(): WorkbenchPendingUserInputRequest[] {
    return [...this.pending.values()].flatMap(entry => entry.status === "shown" && entry.request ? [{
      harness: entry.harness, itemId: entry.itemId, request: entry.request,
      requestKey: entry.requestKey, threadId: entry.threadId, turnId: entry.turnId,
    }] : []);
  }

  async respond(input: { threadId: string; requestKey: string; response: WorkbenchUserInputResponse }) {
    const entry = [...this.pending.values()].find(candidate => candidate.threadId === input.threadId && candidate.requestKey === input.requestKey);
    if (!entry || entry.status !== "shown" || !entry.request) throw new Error("That approval is no longer pending.");
    const question = entry.request.questions.find(candidate => candidate.id === WORKBENCH_APPROVAL_DECISION_QUESTION_ID);
    const offered = new Set(question?.options.map(option => option.label) ?? []);
    const selected = (input.response.answers[WORKBENCH_APPROVAL_DECISION_QUESTION_ID]?.answers ?? []).filter(answer => offered.has(answer));
    if (selected.length !== 1) throw new Error("Choose exactly one offered approval option.");
    const choice = selected[0]!;
    const remembered = entry.remember?.candidates.find(candidate => candidate.label === choice) ?? null;
    const decision: WorkbenchApprovalDecision | null = remembered || choice === WORKBENCH_APPROVAL_ALLOW_ONCE_LABEL
      ? { kind: "allowOnce" }
      : choice === WORKBENCH_APPROVAL_ALLOW_SESSION_LABEL
        ? { kind: "allowSession" }
        : choice === WORKBENCH_APPROVAL_DECLINE_LABEL ? { kind: "decline" } : null;
    if (!decision) throw new Error("Choose exactly one offered approval option.");
    const gone = () => new Error("That approval is no longer pending.");
    const isCurrent = () => this.pending.get(key(entry.harness, entry.requestKey)) === entry && !this.lifetime.signal.aborted;
    entry.status = "responding";
    try {
      if (remembered && entry.remember) {
        await this.options.commandApprovals.save(entry.remember.projectId, entry.remember.workdir, remembered.prefix);
      }
      try {
        await this.options.collectAnswerContext(entry.harness, entry.threadId, this.lifetime.signal);
      } catch (error) {
        // The decision already owns settlement; context failure must not ask the user to decide twice.
        this.options.logError(`Approval context preparation failed; the decision will still be delivered: ${sanitize(error)}`);
      }
    } catch (error) {
      // Nothing reached the transport yet, so the question stays answerable.
      if (isCurrent()) entry.status = "shown";
      throw error;
    }
    if (!isCurrent()) throw gone();
    // Settle ownership before delivery so the transport's own cleanup cannot race a second resolution.
    this.pending.delete(key(entry.harness, entry.requestKey));
    let delivered = false;
    try {
      delivered = await this.options.deliver(entry.harness, { threadId: entry.threadId, requestKey: entry.requestKey, decision });
    } finally {
      if (!delivered) this.resolveVisibly(entry, false);
    }
    if (!delivered) throw gone();
    await this.recordOutcome(entry, decision.kind === "decline" ? "denied" : "approved");
    this.resolveVisibly(entry, true);
    return { ok: true as const };
  }

  dispose() {
    this.lifetime.abort(new Error("The approval controller was disposed."));
    for (const entry of this.pending.values()) {
      if (entry.status === "opening") continue;
      // Thread state is retiring with this owner; transports re-open what they still hold.
      this.options.broadcast(entry.harness, { method: "questionnaire/resolved", params: { threadId: entry.threadId, requestKey: entry.requestKey } });
    }
    this.pending.clear();
  }

  private async evaluateSavedRules(entry: PendingApproval, subject: Extract<WorkbenchApprovalSubject, { kind: "command" }>): Promise<WorkbenchApprovalDecision | null> {
    const argv = parseApprovalCommand(subject.command);
    const workdir = canonicalApprovalWorkdir(subject.cwd);
    if (!argv || !workdir) return null;
    const projectId = await this.options.resolveProject(entry.threadId);
    if (!projectId) return null;
    const saved = await this.options.commandApprovals.match(projectId, workdir, argv);
    if (saved) {
      if (hasApprovalConfirmation(subject.justification)) return { kind: "allowOnce" };
      return {
        kind: "decline",
        feedback: `The command prefix ${JSON.stringify(saved.prefix)} has previously been approved to run outside the sandbox in ${saved.workdir} for this thread's project, but you must explicitly state that you are not bundling additional shell code into the command. If true, resubmit with this exact sentence on its own line in justification: "${COMMAND_APPROVAL_CONFIRMATION}" Otherwise, separate the shell operations and request approval normally. This is an automatic Workbench check, not a user rejection.`,
      };
    }
    const prefixes: string[][] = [];
    for (const candidate of [...subject.suggestedPrefixes, getPackageScriptPrefix(argv)]) {
      if (!candidate || !matchesApprovalPrefix(argv, candidate) || candidate.some(token => !token)) continue;
      if (!prefixes.some(prefix => prefix.length === candidate.length && matchesApprovalPrefix(prefix, candidate))) prefixes.push([...candidate]);
    }
    entry.remember = {
      projectId, workdir,
      candidates: prefixes.map(prefix => ({ prefix, label: `**Always allow** - \`${displayPrefix(prefix)}\` command prefix` })),
    };
    return null;
  }

  private async recordOutcome(entry: PendingApproval, outcome: WorkbenchApprovalOutcome) {
    if (!entry.itemId || !entry.turnId) return;
    try {
      await this.options.recordOutcome({
        threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, outcome, resolvedAt: Date.now(),
      });
    } catch (error) {
      this.options.logError(`Approval outcome was not recorded: ${sanitize(error)}`);
    }
  }

  private resolveVisibly(entry: PendingApproval, answered: boolean) {
    this.options.broadcast(entry.harness, {
      method: "questionnaire/resolved", params: { threadId: entry.threadId, requestKey: entry.requestKey },
    });
    void this.observe(entry, { kind: "inputResolved", requestKey: entry.requestKey, ...(answered ? { answered: true as const } : {}) });
  }

  private async observe(entry: PendingApproval, event: LifecycleEvent) {
    try {
      await this.options.observeLifecycle(entry.harness, entry.threadId, event);
    } catch (error) {
      this.options.logError(`Approval thread state was not updated: ${sanitize(error)}`);
    }
  }
}
