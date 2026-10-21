/*
 * Exports:
 * - ProviderSignInFlow: one native browser sign-in a provider adapter started.
 * - ProviderSignInAdapter: provider mechanics for account reads, browser flows, keys and sign-out.
 * - ProviderSignInSessionOptions: provider key and adapter plus injectable clock, timer and attempt ids.
 * - default ProviderSignInSession: own one provider's sign-in attempt lifecycle: start or join, codes, expiry, cancel and waiters.
 */
import { randomUUID } from "node:crypto";
import type {
  ProviderAccountIntegration, ProviderAccountSnapshot, ProviderSignInAttempt, ProviderSignInStartRequest,
} from "workbench-shared/workbench/provider/provider-account-sign-in";

export interface ProviderSignInFlow {
  url: string;
  userCode: string | null;
  acceptsCode: boolean;
  /** Epoch milliseconds the provider gives up; null uses the session default. */
  expiresAt: number | null;
  /** Resolves when the provider reports success; rejects with its failure. */
  settled: Promise<void>;
  submitCode?(code: string): Promise<void>;
  /** Stops the native flow after cancel, expiry or disposal. */
  cancel(): Promise<void>;
}

export interface ProviderSignInAdapter {
  read(): Promise<ProviderAccountIntegration[]>;
  /** Starts a browser method; the signal aborts when the attempt ends for any reason. */
  begin(integrationId: string, methodId: string, signal: AbortSignal): Promise<ProviderSignInFlow>;
  connectKey(integrationId: string, methodId: string, key: string): Promise<void>;
  signOut(integrationId: string): Promise<void>;
}

export interface ProviderSignInSessionOptions {
  provider: string;
  adapter: ProviderSignInAdapter;
  now?: () => number;
  /** Runs the callback after the delay; returns a canceller. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
  createId?: () => string;
}

interface ActiveAttempt {
  attempt: ProviderSignInAttempt;
  flow: ProviderSignInFlow;
  lifetime: AbortController;
  /** Resolves once the attempt leaves `pending`. */
  ended: Promise<void>;
  end(): void;
  clearExpiry(): void;
}

const DEFAULT_EXPIRY_MS = 15 * 60_000;
const ERROR_LIMIT = 1500;

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, ERROR_LIMIT);
}

function scheduleTimeout(delayMs: number, callback: () => void) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export default class ProviderSignInSession {
  private current: ActiveAttempt | null = null;
  /** The adapter's in-flight `begin`, before its attempt exists. */
  private starting: Promise<ProviderSignInFlow> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly schedule: NonNullable<ProviderSignInSessionOptions["schedule"]>;
  private readonly createId: () => string;

  constructor(private readonly options: ProviderSignInSessionOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleTimeout;
    this.createId = options.createId ?? randomUUID;
  }

  async read(): Promise<ProviderAccountSnapshot> {
    return {
      provider: this.options.provider,
      integrations: await this.options.adapter.read(),
      attempt: this.current ? { ...this.current.attempt } : null,
    };
  }

  /** Starts a browser attempt or connects a key; a pending attempt is joined instead of replaced. */
  async start({ integrationId, methodId, key }: Omit<ProviderSignInStartRequest, "provider">): Promise<ProviderAccountSnapshot> {
    if (this.disposed) throw new Error("Provider sign-in is reloading. Try again.");
    if (this.current?.attempt.state === "pending") return await this.read();
    const integration = (await this.options.adapter.read()).find(candidate => candidate.id === integrationId);
    const method = integration?.methods.find(candidate => candidate.id === methodId);
    if (!method) throw new Error("That sign-in method isn't available.");
    if (method.kind === "key") {
      if (!key) throw new Error("Enter a key to connect.");
      await this.options.adapter.connectKey(integrationId, methodId, key);
      return await this.read();
    }
    // Concurrent starts join the first so no native flow is ever left without an owner.
    if (this.starting) {
      await this.starting.catch(() => undefined);
      return await this.read();
    }
    const lifetime = new AbortController();
    const beginning = this.options.adapter.begin(integrationId, methodId, lifetime.signal);
    this.starting = beginning;
    let flow: ProviderSignInFlow;
    try { flow = await beginning; }
    finally { this.starting = null; }
    if (this.disposed) {
      lifetime.abort();
      await flow.cancel();
      throw new Error("Provider sign-in is reloading. Try again.");
    }
    let end!: () => void;
    const ended = new Promise<void>(resolve => { end = resolve; });
    const expiresAt = flow.expiresAt ?? this.now() + DEFAULT_EXPIRY_MS;
    const active: ActiveAttempt = {
      attempt: {
        id: this.createId(), integrationId, url: flow.url, userCode: flow.userCode, acceptsCode: flow.acceptsCode,
        state: "pending", error: null, expiresAt,
      },
      flow, lifetime, ended, end, clearExpiry: () => undefined,
    };
    this.current = active;
    active.clearExpiry = this.schedule(Math.max(0, expiresAt - this.now()), () => {
      void this.stop(active, "failed", "Sign-in expired. Try again.");
    });
    flow.settled.then(
      () => this.finish(active, "succeeded", null),
      (error: unknown) => this.finish(active, "failed", message(error)),
    );
    return await this.read();
  }

  async submitCode(attemptId: string, code: string): Promise<ProviderAccountSnapshot> {
    const active = this.pending(attemptId);
    if (!active.flow.submitCode) throw new Error("This sign-in doesn't take a code.");
    await active.flow.submitCode(code.trim());
    return await this.read();
  }

  /** Resolves once the attempt ends; an attempt that already ended or was replaced resolves at once. */
  async wait(attemptId: string): Promise<ProviderAccountSnapshot> {
    const active = this.current;
    if (active?.attempt.id === attemptId) await active.ended;
    return await this.read();
  }

  async cancel(attemptId: string): Promise<ProviderAccountSnapshot> {
    const active = this.current;
    if (active?.attempt.id === attemptId) await this.stop(active, "cancelled", null);
    return await this.read();
  }

  async signOut(integrationId: string): Promise<ProviderAccountSnapshot> {
    if (this.current?.attempt.state === "pending" && this.current.attempt.integrationId === integrationId) {
      await this.stop(this.current, "cancelled", null);
    }
    await this.options.adapter.signOut(integrationId);
    return await this.read();
  }

  async dispose() {
    this.disposed = true;
    if (this.current) await this.stop(this.current, "cancelled", "Sign-in was interrupted by a reload.");
  }

  private pending(attemptId: string) {
    const active = this.current;
    if (active?.attempt.id !== attemptId || active.attempt.state !== "pending") throw new Error("This sign-in already ended.");
    return active;
  }

  /** Ends the attempt once; later provider reports for it are ignored. */
  private finish(active: ActiveAttempt, state: Exclude<ProviderSignInAttempt["state"], "pending">, error: string | null) {
    if (active.attempt.state !== "pending") return false;
    active.attempt = { ...active.attempt, state, error };
    active.clearExpiry();
    active.lifetime.abort();
    active.end();
    return true;
  }

  private async stop(active: ActiveAttempt, state: "failed" | "cancelled", error: string | null) {
    if (!this.finish(active, state, error)) return;
    try { await active.flow.cancel(); }
    catch (failure) { console.warn(`[provider-sign-in] ${this.options.provider} cancel failed: ${message(failure)}`); }
  }
}
