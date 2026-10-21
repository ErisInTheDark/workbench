/*
 * Exports:
 * - CODEX_AUTO_REVIEW_OUTPUT_SCHEMA: structured verdict Codex must return.
 * - parseCodexReviewVerdict: map Codex's final message to an approval verdict; only low/medium-risk allows decide.
 * - codexReviewAvailability: whether a Codex account can use auto-review.
 * - CodexApprovalReviewerOptions: isolated transport and scratch directory ports.
 * - default CodexApprovalReviewer: judge one approval with Codex's hidden auto-review model in an ephemeral, read-only, tool-less thread.
 */
import { z } from "zod";
import type { ApprovalReviewerAvailability, ApprovalReviewVerdict } from "workbench-shared/workbench/approval-review/approval-review-settings";
import type { CodexAccount } from "./CodexConfigurationController";
import type { CodexIsolatedTransport } from "./CodexIsolatedAppServerTransport";
import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";

export const CODEX_AUTO_REVIEW_OUTPUT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "risk", "rationale"],
  properties: {
    decision: { type: "string", enum: ["allow", "deny"] },
    risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
    rationale: { type: "string" },
  },
};

const VerdictSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  risk: z.enum(["low", "medium", "high", "critical"]),
  rationale: z.string().trim().min(1).max(2000),
}).strict();

const INSTRUCTIONS = [
  "You review one action an AI coding agent wants to run on the user's own computer outside its sandbox.",
  "Allow only routine actions whose effects match the stated justification and are easily reversible.",
  "Deny anything that deletes or overwrites user data, weakens security, exposes secrets, installs untrusted software,",
  "contacts unexpected hosts, or does more than the justification explains. When unsure, deny: the user is asked instead.",
  "Reply only with the requested JSON: decision, risk, and a one-sentence rationale.",
].join(" ");

const MODEL = "codex-auto-review";

export function parseCodexReviewVerdict(text: string): ApprovalReviewVerdict {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Codex auto-review returned text that is not JSON.");
  }
  const verdict = VerdictSchema.safeParse(value);
  if (!verdict.success) throw new Error("Codex auto-review returned an unexpected verdict shape.");
  const { decision, risk, rationale } = verdict.data;
  return decision === "allow" && (risk === "low" || risk === "medium")
    ? { decision: "allow", detail: `Codex auto-review (${risk} risk): ${rationale}` }
    : { decision: "manual", detail: `Codex auto-review (${decision}, ${risk} risk): ${rationale}` };
}

/** Codex auto-review runs on ChatGPT-plan usage; API-key and Bedrock logins cannot reach the model. */
export function codexReviewAvailability(account: CodexAccount | null): ApprovalReviewerAvailability {
  if (!account) return { ready: false, detail: "Sign in to Codex with ChatGPT" };
  if (account.type !== "chatgpt") return { ready: false, detail: "Needs a ChatGPT login" };
  return { ready: true, detail: null };
}

export interface CodexApprovalReviewerOptions {
  createTransport(onMessage: (message: unknown) => Promise<void>, onFailure: (error: Error) => void): CodexIsolatedTransport;
  /** Empty scratch cwd for review threads; nothing is ever written there. */
  reviewDirectory: string;
}

type Waiter = { text: string | null; resolve(text: string): void; reject(error: Error): void };

const notification = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
const itemCompleted = z.object({ threadId: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }).passthrough() });
const turnCompleted = z.object({
  threadId: z.string(),
  turn: z.object({ status: z.string(), error: z.object({ message: z.string() }).passthrough().nullish() }).passthrough(),
});

export default class CodexApprovalReviewer {
  private transport: CodexIsolatedTransport | null = null;
  private ready: Promise<void> | null = null;
  private readonly waiters = new Map<string, Waiter>();
  private disposed = false;

  constructor(private readonly options: CodexApprovalReviewerOptions) {}

  async review(state: string, signal: AbortSignal): Promise<ApprovalReviewVerdict> {
    const transport = await this.prepare();
    signal.throwIfAborted();
    const started = z.object({ thread: z.object({ id: z.string() }) }).parse(await transport.request({
      method: "thread/start",
      params: {
        model: MODEL, allowProviderModelFallback: false, cwd: this.options.reviewDirectory,
        approvalPolicy: "never", sandbox: "read-only", ephemeral: true, baseInstructions: INSTRUCTIONS,
      },
    }));
    const threadId = started.thread.id;
    const finished = new Promise<string>((resolve, reject) => this.waiters.set(threadId, { text: null, resolve, reject }));
    const onAbort = () => this.settle(threadId, signal.reason instanceof Error ? signal.reason : new Error("Codex auto-review was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await transport.request({
        method: "turn/start",
        params: {
          threadId, effort: "low", outputSchema: CODEX_AUTO_REVIEW_OUTPUT_SCHEMA,
          input: [{ type: "text", text: state, text_elements: [] }],
        },
      });
      return parseCodexReviewVerdict(await finished);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.waiters.delete(threadId);
    }
  }

  async dispose() {
    this.disposed = true;
    for (const threadId of [...this.waiters.keys()]) this.settle(threadId, new Error("Codex auto-review stopped."));
    const transport = this.transport;
    this.transport = null;
    this.ready = null;
    await transport?.dispose();
  }

  private prepare() {
    if (this.disposed) return Promise.reject(new Error("Codex auto-review is disposed."));
    if (!this.transport) {
      this.transport = this.options.createTransport(message => this.observe(message), error => this.fail(error));
    }
    const transport = this.transport;
    this.ready ??= transport.request({
      method: "initialize",
      params: { clientInfo: { name: "workbench-auto-review", title: "Workbench auto-review", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } },
    }).then(() => undefined);
    const ready = this.ready;
    // A failed start must not poison later reviews; the caller still sees this rejection.
    void ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready.then(() => transport);
  }

  private async observe(message: unknown) {
    const parsed = notification.safeParse(message);
    if (!parsed.success) return;
    const { method, params } = parsed.data;
    if (method === "item/completed") {
      const item = itemCompleted.safeParse(params);
      const waiter = item.success ? this.waiters.get(item.data.threadId) : undefined;
      if (waiter && item.data.item.type === "agentMessage" && item.data.item.text) waiter.text = item.data.item.text;
    } else if (method === "turn/completed") {
      const turn = turnCompleted.safeParse(params);
      if (!turn.success) return;
      const waiter = this.waiters.get(turn.data.threadId);
      if (!waiter) return;
      if (turn.data.turn.status !== "completed") {
        this.settle(turn.data.threadId, new Error(turn.data.turn.error?.message.slice(0, 300) ?? `Codex auto-review turn ${turn.data.turn.status}.`));
      } else if (!waiter.text) {
        this.settle(turn.data.threadId, new Error("Codex auto-review finished without a verdict."));
      } else {
        this.waiters.delete(turn.data.threadId);
        waiter.resolve(waiter.text);
      }
    }
  }

  private settle(threadId: string, error: Error) {
    const waiter = this.waiters.get(threadId);
    if (!waiter) return;
    this.waiters.delete(threadId);
    waiter.reject(error);
  }

  private fail(error: Error) {
    for (const threadId of [...this.waiters.keys()]) this.settle(threadId, error);
    // The process is gone; the next review starts a fresh one.
    const transport = this.transport;
    this.transport = null;
    this.ready = null;
    void transport?.dispose().catch(cleanup => {
      console.warn("[approval-review] Codex auto-review cleanup failed:", String(cleanup instanceof Error ? cleanup.message : cleanup).slice(0, 300));
    });
  }
}
