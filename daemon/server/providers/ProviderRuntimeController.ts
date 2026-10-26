/*
 * Exports:
 * - ProviderRuntimeControllerOptions: data root and captured pins plus injectable target, npm and executable probe.
 * - default ProviderRuntimeController: own single-flight installs, status reads and pin auto-follow for Workbench-installed provider runtimes.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { runBundledNpm } from "../lib/managed-npm-install";
import {
  ProviderRuntimeKeySchema,
  type ProviderRuntimeKey,
  type ProviderRuntimeStatus,
  type ProviderRuntimesSnapshot,
} from "workbench-shared/workbench/provider/provider-runtime";
import {
  PROVIDER_RUNTIME_STAGING_PREFIX,
  commitProviderRuntime,
  currentProviderRuntimeTarget,
  probeExecutableVersion,
  providerRuntimeDefinitions,
  providerRuntimeRoot,
  providerRuntimeVersionRoot,
  readInstalledProviderRuntime,
  removeOtherProviderRuntimeVersions,
  type InstalledProviderRuntime,
  type ProviderRuntimeDefinition,
  type ProviderRuntimePins,
  type ProviderRuntimeTarget,
} from "./provider-runtimes";

const ERROR_LIMIT = 1500;

export interface ProviderRuntimeControllerOptions {
  dataRoot: string;
  /** Pins this daemon process loaded; installs and status never follow a newer checkout before a restart. */
  pins: ProviderRuntimePins;
  warn: (message: string) => void;
  definitions?: Record<ProviderRuntimeKey, ProviderRuntimeDefinition>;
  target?: ProviderRuntimeTarget;
  /** Runs npm with the given arguments; rejects with npm's failure. */
  runNpm?: (args: string[], signal: AbortSignal) => Promise<void>;
  /** Returns what the executable prints for `--version`. */
  probe?: (executable: string, signal: AbortSignal) => Promise<string>;
}

function bounded(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail = typeof stderr === "string" && stderr.trim() ? `${message}\n${stderr.trim().slice(-800)}` : message;
  return detail.slice(0, ERROR_LIMIT);
}

class VerifyFailure extends Error {}

export default class ProviderRuntimeController {
  private readonly flights = new Map<ProviderRuntimeKey, Promise<void>>();
  private readonly failures = new Map<ProviderRuntimeKey, string>();
  private readonly lifetime = new AbortController();
  private readonly definitions: Record<ProviderRuntimeKey, ProviderRuntimeDefinition>;
  private readonly target: ProviderRuntimeTarget;
  private readonly runNpm: NonNullable<ProviderRuntimeControllerOptions["runNpm"]>;
  private readonly probe: NonNullable<ProviderRuntimeControllerOptions["probe"]>;

  constructor(private readonly options: ProviderRuntimeControllerOptions) {
    this.definitions = options.definitions ?? providerRuntimeDefinitions;
    this.target = options.target ?? currentProviderRuntimeTarget();
    this.runNpm = options.runNpm ?? runBundledNpm;
    this.probe = options.probe ?? probeExecutableVersion;
  }

  /** Reinstalls runtimes the user already installed whose pin moved with a Workbench update. */
  start() {
    for (const key of ProviderRuntimeKeySchema.options) {
      const status = this.status(key);
      if (status.state === "missing" && status.installedVersion !== null) void this.begin(key);
    }
  }

  async read(): Promise<ProviderRuntimesSnapshot> {
    return { data: ProviderRuntimeKeySchema.options.map(key => this.status(key)) };
  }

  /** Starts or joins the provider's install and resolves with the snapshot once it settles. */
  async install(key: ProviderRuntimeKey): Promise<ProviderRuntimesSnapshot> {
    if (this.lifetime.signal.aborted) throw new Error("Provider runtimes are reloading.");
    const status = this.status(key);
    if (status.state === "installing") await this.flights.get(key);
    else if (status.state === "missing" || status.state === "failed") await this.begin(key);
    return await this.read();
  }

  async dispose() {
    this.lifetime.abort(new Error("Provider runtime installs were interrupted by a reload."));
    await Promise.allSettled(this.flights.values());
  }

  private status(key: ProviderRuntimeKey): ProviderRuntimeStatus {
    const definition = this.definitions[key];
    let version = "";
    try {
      const pin = this.options.pins[key]();
      version = pin.version;
      if (!definition.packages(this.target).length) {
        return { provider: key, version, installedVersion: null, state: "unsupported",
          error: `${definition.label} has no build for ${this.target.platform}-${this.target.arch}.` };
      }
      const current = readInstalledProviderRuntime(providerRuntimeVersionRoot(this.options.dataRoot, key, pin.packageVersion));
      if (this.flights.has(key)) return { provider: key, version, installedVersion: current?.version ?? this.stale(key, pin.packageVersion)?.version ?? null, state: "installing", error: null };
      if (current) return { provider: key, version, installedVersion: current.version, state: "ready", error: null };
      const failure = this.failures.get(key);
      const installedVersion = this.stale(key, pin.packageVersion)?.version ?? null;
      return failure ? { provider: key, version, installedVersion, state: "failed", error: failure }
        : { provider: key, version, installedVersion, state: "missing", error: null };
    } catch (error) {
      return { provider: key, version, installedVersion: null, state: "failed", error: bounded(error) };
    }
  }

  /** A committed runtime for a previous pin, if any. */
  private stale(key: ProviderRuntimeKey, packageVersion: string): InstalledProviderRuntime | null {
    const root = providerRuntimeRoot(this.options.dataRoot, key);
    if (!existsSync(root)) return null;
    for (const entry of readdirSync(root).filter(name => name !== packageVersion && !name.startsWith(PROVIDER_RUNTIME_STAGING_PREFIX)).sort().reverse()) {
      const installed = readInstalledProviderRuntime(path.join(root, entry));
      if (installed) return installed;
    }
    return null;
  }

  private begin(key: ProviderRuntimeKey) {
    const existing = this.flights.get(key);
    if (existing) return existing;
    this.failures.delete(key);
    const signal = this.lifetime.signal;
    const flight = this.perform(key, signal).catch((error: unknown) => {
      if (signal.aborted) return;
      const message = bounded(error);
      this.failures.set(key, message);
      this.options.warn(`${this.definitions[key].label} runtime install failed: ${message}`);
    }).finally(() => { this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }

  private async perform(key: ProviderRuntimeKey, signal: AbortSignal) {
    const definition = this.definitions[key];
    const pin = this.options.pins[key]();
    const root = providerRuntimeRoot(this.options.dataRoot, key);
    const versionRoot = providerRuntimeVersionRoot(this.options.dataRoot, key, pin.packageVersion);
    await mkdir(root, { recursive: true });
    let verifyFailure: VerifyFailure | null = null;
    for (const packageName of definition.packages(this.target)) {
      const staging = await mkdtemp(path.join(root, PROVIDER_RUNTIME_STAGING_PREFIX));
      try {
        signal.throwIfAborted();
        await this.runNpm([
          "install", "--prefix", staging, "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund",
          `${packageName}@${pin.packageVersion}`,
        ], signal);
        const executable = path.join("node_modules", packageName, definition.executable(this.target));
        let reported: string;
        try { reported = await this.probe(path.join(staging, executable), signal); }
        catch (error) {
          if (signal.aborted) throw error;
          throw new VerifyFailure(`${packageName} failed to run: ${bounded(error)}`);
        }
        if (!reported.includes(pin.version)) {
          throw new VerifyFailure(`${packageName} reported "${reported.slice(0, 120)}" instead of ${pin.version}.`);
        }
        const marker: InstalledProviderRuntime = { packageName, packageVersion: pin.packageVersion, version: pin.version, executable };
        await commitProviderRuntime(staging, versionRoot, marker, signal);
        await removeOtherProviderRuntimeVersions(root, pin.packageVersion, this.options.warn);
        return;
      } catch (error) {
        await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch((cleanup: unknown) => {
          this.options.warn(`Could not remove runtime staging ${staging}: ${bounded(cleanup)}`);
        });
        if (!(error instanceof VerifyFailure)) throw error;
        verifyFailure = error;
      }
    }
    throw verifyFailure ?? new Error(`${definition.label} has no build for ${this.target.platform}-${this.target.arch}.`);
  }
}
