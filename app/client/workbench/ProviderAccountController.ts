/*
 * Exports:
 * - ProviderAccountState: one provider's account snapshot, busy flag and last error.
 * - ProviderAccountPort: the daemon calls provider sign-in needs.
 * - default ProviderAccountController: own one daemon's provider account reads, sign-in attempts and sign-outs, following pending attempts until they end.
 */
import type {
  ProviderAccountSnapshot, ProviderSignInAttemptRequest, ProviderSignInCodeRequest, ProviderSignInStartRequest, ProviderSignOutRequest,
} from "workbench-shared/workbench/provider/provider-account-sign-in";

export interface ProviderAccountState {
  snapshot: ProviderAccountSnapshot | null;
  busy: boolean;
  error: string;
}

export interface ProviderAccountPort {
  read(provider: string): Promise<ProviderAccountSnapshot>;
  start(params: ProviderSignInStartRequest): Promise<ProviderAccountSnapshot>;
  submitCode(params: ProviderSignInCodeRequest): Promise<ProviderAccountSnapshot>;
  wait(params: ProviderSignInAttemptRequest): Promise<ProviderAccountSnapshot>;
  cancel(params: ProviderSignInAttemptRequest): Promise<ProviderAccountSnapshot>;
  signOut(params: ProviderSignOutRequest): Promise<ProviderAccountSnapshot>;
}

const EMPTY: ProviderAccountState = { snapshot: null, busy: false, error: "" };

function failure(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback).slice(0, 500);
}

export default class ProviderAccountController {
  private states: Readonly<Record<string, ProviderAccountState>> = {};
  private readonly listeners = new Set<() => void>();
  /** Newer operations for a provider fence older replies out of its state. */
  private readonly generations = new Map<string, number>();
  /** Attempts already being followed, so repeated snapshots never stack waits. */
  private readonly following = new Set<string>();
  private disposed = false;

  constructor(private readonly port: ProviderAccountPort) {}

  getSnapshot = () => this.states;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  state(provider: string) { return this.states[provider] ?? EMPTY; }

  refresh(provider: string) { return this.perform(provider, () => this.port.read(provider)); }

  start(provider: string, integrationId: string, methodId: string, key?: string) {
    return this.perform(provider, () => this.port.start({ provider, integrationId, methodId, ...key ? { key } : {} }));
  }

  submitCode(provider: string, attemptId: string, code: string) {
    return this.perform(provider, () => this.port.submitCode({ provider, attemptId, code }));
  }

  cancel(provider: string, attemptId: string) { return this.perform(provider, () => this.port.cancel({ provider, attemptId })); }

  signOut(provider: string, integrationId: string) {
    return this.perform(provider, () => this.port.signOut({ provider, integrationId }));
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Resolves true when the daemon accepted the operation. */
  private async perform(provider: string, operation: () => Promise<ProviderAccountSnapshot>) {
    if (this.disposed) return false;
    const generation = (this.generations.get(provider) ?? 0) + 1;
    this.generations.set(provider, generation);
    this.update(provider, { busy: true, error: "" });
    try {
      const snapshot = await operation();
      if (this.current(provider, generation)) this.accept(provider, snapshot);
      return true;
    } catch (error) {
      if (this.current(provider, generation)) this.update(provider, { busy: false, error: failure(error, "Sign-in failed.") });
      return false;
    }
  }

  private current(provider: string, generation: number) {
    return !this.disposed && this.generations.get(provider) === generation;
  }

  private accept(provider: string, snapshot: ProviderAccountSnapshot) {
    this.update(provider, { snapshot, busy: false, error: "" });
    const attempt = snapshot.attempt;
    if (attempt?.state === "pending" && !this.following.has(attempt.id)) void this.follow(provider, attempt.id);
  }

  /** The daemon keeps the attempt if this wait drops; a fresh read shows its real state. */
  private async follow(provider: string, attemptId: string) {
    this.following.add(attemptId);
    try {
      const snapshot = await this.port.wait({ provider, attemptId }).catch(() => this.port.read(provider));
      if (!this.disposed && snapshot.attempt?.id === attemptId) this.update(provider, { snapshot });
    } catch (error) {
      this.update(provider, { error: failure(error, "Couldn't check the sign-in. Refresh to try again.") });
    } finally {
      this.following.delete(attemptId);
    }
  }

  private update(provider: string, patch: Partial<ProviderAccountState>) {
    if (this.disposed) return;
    this.states = { ...this.states, [provider]: { ...this.state(provider), ...patch } };
    for (const listener of this.listeners) listener();
  }
}
