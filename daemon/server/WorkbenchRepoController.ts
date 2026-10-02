/*
 * Exports:
 * - WorkbenchRepoSidecar/WorkbenchRepoControllerOptions: injectable sidecar and clock ports.
 * - REPO_LEASE_MS: how long one explicit warm keeps a commit mounted.
 * - default WorkbenchRepoController: own virtual repository availability, 24-hour leases, sidecar lifetime, expiry and batched subtree hydration.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  VirtualRepoWarmRequestSchema, VirtualRepoWarmResultSchema, type VirtualRepoAvailability,
} from "workbench-shared/workbench/repo/virtual-repo-contract";

export const REPO_LEASE_MS = 24 * 60 * 60 * 1000;
// setTimeout clamps larger delays to 1ms; longer leases re-arm when the timer fires.
const MAX_TIMER_MS = 2_147_483_647;

export interface WorkbenchRepoSidecar {
  readonly failed: boolean;
  request(action: string, payload: object, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface WorkbenchRepoControllerOptions {
  cacheDirectory: string;
  probe: () => Promise<VirtualRepoAvailability>;
  startSidecar: () => Promise<WorkbenchRepoSidecar>;
  bumpToolRevision: () => void;
  warn: (message: string) => void;
  now?: () => number;
  /** The callback's promise settles when that expiry pass finishes. */
  setTimer?: (callback: () => Promise<void>, delayMs: number) => { cancel(): void };
}

const LeaseSchema = z.object({
  key: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/u),
  path: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
}).strict();
type Lease = z.infer<typeof LeaseSchema>;
const LeaseFileSchema = z.object({ version: z.literal(1), leases: z.array(LeaseSchema) }).strict();

function text(status: number, body: string) {
  return new Response(`${body}\n`, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

function message(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 600);
}

function describeUnavailable(availability: VirtualRepoAvailability | null) {
  switch (availability?.status) {
    case "missing":
      return availability.requirement === "git" ? "git 2.44 or newer is not installed"
        : availability.requirement === "winfsp" ? "WinFsp is not installed" : "FUSE is not available";
    case "nativeMissing": return "the bundled repository sidecar is missing or stale";
    case "unsupported": return "this platform is not supported";
    case "checkFailed": return "the prerequisite check failed";
    default: return "availability is still being checked";
  }
}

export default class WorkbenchRepoController {
  private availability: VirtualRepoAvailability | null = null;
  private probing: Promise<VirtualRepoAvailability> | null = null;
  private readonly leases = new Map<string, Lease>();
  private loaded: Promise<void> | null = null;
  private reconciling: Promise<void> = Promise.resolve();
  private sidecar: WorkbenchRepoSidecar | null = null;
  private ready: Promise<WorkbenchRepoSidecar> | null = null;
  private timer: { cancel(): void } | null = null;
  private readonly inflight = new Map<AbortController, Promise<unknown>>();
  private accepting = true;
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<WorkbenchRepoControllerOptions["setTimer"]>;

  constructor(private readonly options: WorkbenchRepoControllerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const handle = setTimeout(() => { void callback(); }, delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });
  }

  /** Synchronous view for command catalogues: only a positive probe exposes the command. */
  isAvailable() {
    return this.availability?.status === "available";
  }

  /** Probes again; a changed answer invalidates prepared provider tool lists. */
  async refreshAvailability(): Promise<VirtualRepoAvailability> {
    this.probing ??= this.options.probe().then(next => {
      const was = this.isAvailable();
      this.availability = next;
      if (was !== this.isAvailable()) this.options.bumpToolRevision();
      return next;
    }).finally(() => { this.probing = null; });
    return await this.probing;
  }

  /** Settles when reconciliation finishes; failures are reported, never thrown, so callers may leave it running. */
  start(): Promise<void> {
    this.reconciling = this.reconcile().catch(error => this.options.warn(`Virtual repository startup failed: ${message(error, "unknown error")}`));
    return this.reconciling;
  }

  private async reconcile() {
    await this.load();
    await this.refreshAvailability();
    // Cache left by leases that expired while unavailable still needs a sweep.
    if (this.isAvailable() && (this.leases.size || await this.hasCachedRepositories())) await this.ensureSidecar();
    else this.schedule();
  }

  private async hasCachedRepositories() {
    try {
      return (await fs.readdir(path.join(this.options.cacheDirectory, "git"))).length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.warn(`Repository cache could not be inspected: ${message(error, "unknown error")}`);
      }
      return false;
    }
  }

  async warm(body: object, signal: AbortSignal): Promise<Response> {
    const parsed = VirtualRepoWarmRequestSchema.safeParse(body);
    if (!parsed.success) return text(400, "A valid repository URL is required, without credentials.");
    if (!this.accepting) return text(503, "Virtual repositories are reloading; try again shortly.");
    if (!this.isAvailable()) {
      return text(503, `Virtual repositories are unavailable on this host: ${describeUnavailable(this.availability)}. See Settings > Agents > Capabilities.`);
    }
    const abort = new AbortController();
    const forward = () => abort.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    const operation = this.warmLeased(parsed.data, abort.signal);
    this.inflight.set(abort, operation);
    try {
      return text(200, await operation);
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason;
      // A failed warm may mean the driver or git disappeared; refresh so the catalogue follows.
      void this.refreshAvailability().catch(failure => this.options.warn(`Repository availability check failed: ${message(failure, "unknown error")}`));
      return text(400, `Repository warm failed: ${message(error, "unknown error")}`);
    } finally {
      signal.removeEventListener("abort", forward);
      this.inflight.delete(abort);
    }
  }

  /**
   * Fetches a mounted subtree's content in one batch for a caller about to read all of it, such as a search.
   * Paths outside leased mounts are ignored without starting the sidecar; failures reject for the caller to report.
   */
  async hydrate(absolutePath: string, signal: AbortSignal): Promise<void> {
    if (!this.accepting || !this.isAvailable()) return;
    await this.load();
    const target = path.resolve(absolutePath);
    for (const lease of this.leases.values()) {
      const relative = path.relative(path.resolve(lease.path), target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const sidecar = await this.ensureSidecar();
      await sidecar.request("prefetch", {
        key: lease.key, commit: lease.commit, path: relative.split(path.sep).join("/"),
      }, signal);
      return;
    }
  }

  private async warmLeased(request: z.infer<typeof VirtualRepoWarmRequestSchema>, signal: AbortSignal) {
    await this.load();
    const sidecar = await this.ensureSidecar();
    const result = VirtualRepoWarmResultSchema.parse(await sidecar.request("warm", {
      url: request.url, ref: request.ref ?? "", kind: request.kind ?? "",
    }, signal));
    this.leases.set(`${result.key}@${result.commit}`, { ...result, expiresAt: this.now() + REPO_LEASE_MS });
    await this.persist();
    this.schedule();
    return result.path;
  }

  /** One owner for "sidecar started, stale cache swept, live leases remounted". */
  private async ensureSidecar(): Promise<WorkbenchRepoSidecar> {
    if (this.sidecar?.failed) this.reset();
    this.ready ??= (async () => {
      const sidecar = await this.options.startSidecar();
      this.sidecar = sidecar;
      this.dropExpired();
      await sidecar.request("sweep", { keep: [...new Set([...this.leases.values()].map(lease => lease.key))] });
      for (const [identity, lease] of this.leases) {
        try {
          await sidecar.request("remount", { key: lease.key, commit: lease.commit });
        } catch (error) {
          // The agent re-warms when a path is missing; keep the lease so its cache survives.
          this.options.warn(`Leased repository ${identity.slice(0, 120)} could not be remounted: ${message(error, "unknown error")}`);
        }
      }
      await this.persist();
      this.schedule();
      return sidecar;
    })();
    try {
      return await this.ready;
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  private reset() {
    const sidecar = this.sidecar;
    this.sidecar = null;
    this.ready = null;
    if (sidecar) void sidecar.close().catch(error => this.options.warn(`Repository process close failed: ${message(error, "unknown error")}`));
  }

  private dropExpired() {
    const now = this.now();
    const expired: Lease[] = [];
    for (const [identity, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        expired.push(lease);
        this.leases.delete(identity);
      }
    }
    return expired;
  }

  private schedule() {
    this.timer?.cancel();
    this.timer = null;
    if (!this.accepting || !this.leases.size) return;
    const soonest = Math.min(...[...this.leases.values()].map(lease => lease.expiresAt));
    this.timer = this.setTimer(() => this.expire(), Math.min(MAX_TIMER_MS, Math.max(0, soonest - this.now())));
  }

  private async expire() {
    const expired = this.dropExpired();
    if (expired.length) {
      const liveKeys = new Set([...this.leases.values()].map(lease => lease.key));
      const sidecar = this.sidecar && !this.sidecar.failed ? this.sidecar : null;
      for (const lease of expired) {
        try {
          if (!sidecar) continue;
          await sidecar.request("unmount", { key: lease.key, commit: lease.commit });
          if (!liveKeys.has(lease.key)) {
            liveKeys.add(lease.key); // evict each key once
            await sidecar.request("evict", { key: lease.key });
          }
        } catch (error) {
          this.options.warn(`Expired repository cleanup failed: ${message(error, "unknown error")}`);
        }
      }
      // Without a running sidecar, the next start sweeps unleased cache instead.
      await this.persist().catch(error => this.options.warn(`Repository leases could not be saved: ${message(error, "unknown error")}`));
    }
    this.schedule();
  }

  private load() {
    this.loaded ??= (async () => {
      let raw: unknown = null;
      try {
        raw = JSON.parse(await fs.readFile(this.leaseFile(), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.options.warn("Repository leases were unreadable and have been reset.");
        }
      }
      const conformed = conformToZodSchema(LeaseFileSchema, raw, { version: 1, leases: [] });
      for (const lease of conformed.data.leases) this.leases.set(`${lease.key}@${lease.commit}`, lease);
    })();
    return this.loaded;
  }

  private leaseFile() {
    return path.join(this.options.cacheDirectory, "leases.json");
  }

  private persist() {
    const snapshot = { version: 1 as const, leases: [...this.leases.values()] };
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await fs.mkdir(this.options.cacheDirectory, { recursive: true });
      const temporary = `${this.leaseFile()}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
      await fs.rename(temporary, this.leaseFile());
    });
    return this.writes;
  }

  async readAvailability(): Promise<VirtualRepoAvailability> {
    return await this.refreshAvailability();
  }

  // Reload handoff: drain warms, then close the sidecar so the replacement can mount the same paths.
  async waitForIdle() {
    this.accepting = false;
    this.timer?.cancel();
    this.timer = null;
    await Promise.allSettled(this.inflight.values());
  }

  expireInflight() {
    for (const abort of this.inflight.keys()) abort.abort(new Error("Repository warm was cancelled by a reload."));
  }

  async suspend() {
    await this.waitForIdle();
    // A reconcile still in flight could otherwise start a sidecar after this closes it.
    await this.reconciling;
    await this.writes.catch(() => undefined);
    const sidecar = this.sidecar;
    this.sidecar = null;
    this.ready = null;
    await sidecar?.close();
  }

  resume() {
    this.accepting = true;
    void this.start();
  }

  async dispose() {
    this.expireInflight();
    await this.suspend();
  }
}
