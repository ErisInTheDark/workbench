/*
 * Exports:
 * - McpPackageInstallerOptions: install root plus injectable npm runner and warning sink.
 * - McpPackageSource: the package, version or range and arguments one server launches.
 * - McpPackageState: whether a server's install is present, running, failed (with npm's reason) or missing.
 * - default McpPackageInstaller: own Workbench-installed npm packages of stdio MCP servers, one directory per server under the data root:
 *   single-flight staged background installs and their last failure, the launch command and exact version of each package's bin,
 *   restore of a missing install at its pinned version, and removal.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { commitStagedDirectory, runBundledNpm } from "../lib/managed-npm-install";
import type { McpServerLaunch } from "./McpServerConnection";

export interface McpPackageInstallerOptions {
  /** Directory holding one install directory per server id. */
  root: string;
  warn: (message: string) => void;
  /** Runs npm with the given arguments; rejects with npm's failure. */
  runNpm?: (args: string[], signal: AbortSignal) => Promise<void>;
}

export interface McpPackageSource {
  package: string;
  version: string;
  args: readonly string[];
}

export type McpPackageState = { state: "installed" | "installing" | "missing" } | { state: "failed"; detail: string };

/** `installed.json` of one committed install. */
interface InstalledPackage {
  package: string;
  version: string;
  /** The package's bin, relative to the install directory. */
  bin: string;
  /** Whether the bin is a Node script, run by the daemon's own Node rather than as an executable. */
  node: boolean;
}

const MARKER = "installed.json";
const STAGING_PREFIX = ".staging-";
const ERROR_LIMIT = 1500;
const NODE_SCRIPT = /\.[cm]?js$/u;

function bounded(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail = typeof stderr === "string" && stderr.trim() ? `${message}\n${stderr.trim().slice(-800)}` : message;
  return detail.slice(0, ERROR_LIMIT);
}

/** npm's own `npm error` lines say what went wrong; its exec error leads with the whole command line instead. */
function npmFailure(error: unknown) {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const said = typeof stderr === "string"
    ? stderr.split(/\r?\n/u).flatMap(line => /^npm error (.+)$/u.exec(line.trim())?.[1]?.trim() ?? []).filter(Boolean).slice(0, 3) : [];
  return said.length ? said.join("; ").slice(0, ERROR_LIMIT) : bounded(error);
}

/** The command npx and `pnpm exec` would pick: the only bin, or the one named after the unscoped package. */
function packageBin(manifest: { bin?: unknown }, name: string) {
  const { bin } = manifest;
  if (typeof bin === "string" && bin) return bin;
  const entries = bin && typeof bin === "object"
    ? Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "") : [];
  const unscoped = name.slice(name.indexOf("/") + 1);
  const chosen = entries.length === 1 ? entries[0] : entries.find(([command]) => command === unscoped);
  if (chosen) return chosen[1];
  throw new Error(entries.length
    ? `${name} offers several commands (${entries.map(([command]) => command).join(", ")}) and none is named ${unscoped}.`
    : `${name} has no command to run, so it isn't a stdio MCP server.`);
}

async function isNodeScript(file: string) {
  if (NODE_SCRIPT.test(file)) return true;
  const handle = await open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    return firstLine.startsWith("#!") && /\bnode\b/u.test(firstLine);
  } finally {
    await handle.close();
  }
}

export default class McpPackageInstaller {
  readonly #flights = new Map<string, Promise<InstalledPackage>>();
  /** Why each server's last install failed; cleared when another install starts. */
  readonly #failures = new Map<string, string>();
  readonly #lifetime = new AbortController();
  readonly #runNpm: NonNullable<McpPackageInstallerOptions["runNpm"]>;

  constructor(private readonly options: McpPackageInstallerOptions) {
    this.#runNpm = options.runNpm ?? runBundledNpm;
  }

  /** The server's install as it is now; starts nothing. */
  state(serverId: string): McpPackageState {
    try {
      if (this.#read(this.#directory(serverId))) return { state: "installed" };
    } catch (error) {
      return { state: "failed", detail: bounded(error) };
    }
    if (this.#flights.has(serverId)) return { state: "installing" };
    const failure = this.#failures.get(serverId);
    return failure === undefined ? { state: "missing" } : { state: "failed", detail: failure };
  }

  /** Start installing in the background unless an install is already running; its failure is kept for `state`. */
  install(serverId: string, source: Pick<McpPackageSource, "package" | "version">) {
    void this.#install(serverId, source.package, source.version).catch(() => undefined);
  }

  /** How to start the server's installed bin with its arguments, and the exact version installed; installs first when the install is gone. */
  async launch(serverId: string, source: McpPackageSource): Promise<{ launch: McpServerLaunch; version: string }> {
    const directory = this.#directory(serverId);
    const installed = this.#read(directory) ?? await this.#install(serverId, source.package, source.version);
    const bin = path.join(directory, installed.bin);
    const launch = installed.node
      ? { command: process.execPath, args: [bin, ...source.args], cwd: directory }
      : { command: bin, args: [...source.args], cwd: directory };
    return { launch, version: installed.version };
  }

  /** Close the server's process before removing; a leftover directory is only warned about. */
  async remove(serverId: string) {
    await this.#flights.get(serverId)?.catch(() => undefined);
    this.#failures.delete(serverId);
    await rm(this.#directory(serverId), { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      this.options.warn(`Could not remove MCP package install ${this.#directory(serverId)}: ${bounded(error)}`);
    });
  }

  async dispose() {
    this.#lifetime.abort(new Error("MCP package installs were interrupted by a reload."));
    await Promise.allSettled(this.#flights.values());
  }

  #directory(serverId: string) {
    return path.join(this.options.root, serverId);
  }

  #read(directory: string): InstalledPackage | null {
    let parsed: Partial<InstalledPackage> | null;
    try { parsed = JSON.parse(readFileSync(path.join(directory, MARKER), "utf8")) as Partial<InstalledPackage> | null; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!parsed || typeof parsed.package !== "string" || typeof parsed.version !== "string"
      || typeof parsed.bin !== "string" || typeof parsed.node !== "boolean") {
      throw new Error(`MCP package install marker at ${directory} is malformed.`);
    }
    return existsSync(path.join(directory, parsed.bin)) ? parsed as InstalledPackage : null;
  }

  #install(serverId: string, name: string, version: string) {
    const existing = this.#flights.get(serverId);
    if (existing) return existing;
    this.#failures.delete(serverId);
    const flight = this.#perform(serverId, name, version).catch((error: unknown) => {
      if (!this.#lifetime.signal.aborted) this.#failures.set(serverId, bounded(error));
      throw error;
    }).finally(() => { this.#flights.delete(serverId); });
    this.#flights.set(serverId, flight);
    return flight;
  }

  async #perform(serverId: string, name: string, version: string) {
    const signal = this.#lifetime.signal;
    signal.throwIfAborted();
    await mkdir(this.options.root, { recursive: true });
    const staging = await mkdtemp(path.join(this.options.root, STAGING_PREFIX));
    try {
      try {
        await this.#runNpm(["install", "--prefix", staging, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `${name}@${version}`], signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`npm couldn't install ${name}@${version}: ${npmFailure(error)}`, { cause: error });
      }
      const packageRoot = path.join("node_modules", ...name.split("/"));
      const manifest = JSON.parse(readFileSync(path.join(staging, packageRoot, "package.json"), "utf8")) as { version?: unknown; bin?: unknown };
      if (typeof manifest.version !== "string") throw new Error(`${name} has no version in its package manifest.`);
      const bin = path.join(packageRoot, packageBin(manifest, name));
      if (!existsSync(path.join(staging, bin))) throw new Error(`${name}'s command ${bin} is missing from the installed package.`);
      const installed: InstalledPackage = { package: name, version: manifest.version, bin, node: await isNodeScript(path.join(staging, bin)) };
      await writeFile(path.join(staging, MARKER), `${JSON.stringify(installed, null, 2)}\n`);
      await commitStagedDirectory(staging, this.#directory(serverId), signal);
      return installed;
    } catch (error) {
      await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch((cleanup: unknown) => {
        this.options.warn(`Could not remove MCP package staging ${staging}: ${bounded(cleanup)}`);
      });
      throw error;
    }
  }
}
