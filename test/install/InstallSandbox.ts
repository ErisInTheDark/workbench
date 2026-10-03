/*
 * Exports:
 * - InstallSandboxOptions: source checkout, parent directory and progress output for a sandbox.
 * - default InstallSandbox: build and dispose a throwaway home where the real wb installer runs without touching the host.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallSandboxOptions {
  source?: string;
  parent?: string;
  write?: (text: string) => void;
}

const windows = process.platform === "win32";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRETEND_DISPATCH = path.join(projectRoot, "test", "install", "pretend-dispatch.mjs");
// Commands that would reach the real host, or the real installation, if left on PATH.
const HOST_COMMANDS = ["wb", "vp"];
// Inherited variables that would point sandboxed tools back at host state or the calling agent.
const HOST_VARIABLES = [/^npm_/iu, /^pnpm_/iu, /^VP_/iu, /^PNPM_HOME$/iu, /^NODE_OPTIONS$/iu, /^TSX_/iu,
  /^WORKBENCH_/iu, /^CODEX_/iu, /^CLAUDE_/iu];

type Environment = Record<string, string>;

function setVariable(environment: Environment, name: string, value: string) {
  // Windows variable names are case-insensitive; a stale `Path` beside `PATH` would split lookup.
  if (windows) for (const key of Object.keys(environment)) if (key.toUpperCase() === name.toUpperCase()) delete environment[key];
  environment[name] = value;
}

function readVariable(environment: Environment, name: string) {
  if (!windows) return environment[name];
  return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

async function exists(file: string) {
  try { await fs.access(file, constants.F_OK); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function commandNames(name: string) {
  return windows ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, `${name}.bat`, name] : [name];
}

export default class InstallSandbox {
  readonly home: string;
  readonly vpHome: string;
  readonly npmPrefix: string;
  readonly repository: string;
  readonly links: string[] = [];
  environment: Environment = {};

  private constructor(readonly root: string, private readonly write: (text: string) => void) {
    this.home = path.join(root, "home");
    this.vpHome = path.join(root, "vp-home");
    this.npmPrefix = path.join(root, "npm-global");
    this.repository = path.join(root, "source");
  }

  /** Default checkout location the bootstrap offers inside this sandbox. */
  get defaultCheckout() {
    return windows
      ? path.join(this.home, "AppData", "Local", "Programs", "inthedark", "wb")
      : path.join(this.home, ".local", "lib", "inthedark", "wb");
  }

  /** Directory of the npm-installed `@inthedark/wb` package. */
  get packageRoot() {
    return path.join(this.npmPrefix, ...(windows ? [] : ["lib"]), "node_modules", "@inthedark", "wb");
  }

  get vpBin() { return path.join(this.vpHome, "bin"); }

  static async create({ source = projectRoot, parent = os.tmpdir(), write = () => {} }: InstallSandboxOptions = {}) {
    const sandbox = new InstallSandbox(await fs.mkdtemp(path.join(parent, "wb-install-sandbox-")), write);
    try {
      await sandbox.prepare(path.resolve(source));
      return sandbox;
    } catch (error) {
      try { await sandbox.dispose(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Install sandbox setup and cleanup failed; retained: ${sandbox.root}`);
      }
      throw error;
    }
  }

  private async prepare(source: string) {
    const hostVpHome = process.env.VP_HOME || path.join(os.homedir(), ".vite-plus");
    const hostPnpmStore = await this.hostPnpmStore(source);
    const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
    const nodeVersion: string | undefined = manifest.devEngines?.runtime?.version;
    const packageManager: { name?: string; version?: string } | undefined = manifest.devEngines?.packageManager;
    if (!nodeVersion || !packageManager?.name || !packageManager.version) {
      throw new Error(`${source} must pin devEngines.runtime and devEngines.packageManager.`);
    }
    this.environment = await this.buildEnvironment(hostVpHome);
    // npm, pnpm and vp walk upward for package.json; when the sandbox sits inside a project (test runners
    // redirect TEMP into one), this boundary keeps them from adopting that project's devEngines.
    await fs.writeFile(path.join(this.root, "package.json"), '{ "private": true }\n');
    for (const name of ["HOME", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "VP_HOME", "npm_config_prefix"]) {
      const directory = readVariable(this.environment, name);
      if (directory) await fs.mkdir(directory, { recursive: true });
    }

    this.write("Seeding Vite+ from the host (read-only links)...\n");
    // Junctions are safe because npm's global prefix is redirected below; nothing writes into these.
    await this.link(await fs.realpath(path.join(hostVpHome, "current")), path.join(this.vpHome, "current"));
    await this.link(path.join(hostVpHome, "js_runtime", "node", nodeVersion), path.join(this.vpHome, "js_runtime", "node", nodeVersion));
    await this.link(path.join(hostVpHome, "package_manager", packageManager.name, packageManager.version),
      path.join(this.vpHome, "package_manager", packageManager.name, packageManager.version));
    if (await exists(path.join(hostVpHome, "config.json"))) {
      await fs.copyFile(path.join(hostVpHome, "config.json"), path.join(this.vpHome, "config.json"));
    }
    // Host trampolines resolve VP_HOME from their own location; the sandbox needs its own.
    await this.run(path.join(this.vpHome, "current", "bin", windows ? "vp.exe" : "vp"), ["env", "setup"]);
    if (hostPnpmStore) await this.run("pnpm", ["config", "set", "store-dir", hostPnpmStore, "--global"]);

    const leaked = await this.which("wb");
    if (leaked) throw new Error(`Install sandbox PATH still resolves a host wb: ${leaked}`);

    this.write("Snapshotting the working tree as the install source...\n");
    await this.snapshot(source);

    this.write("Packing and installing the npm package...\n");
    const packed = (await this.run("npm", ["pack", path.join(this.repository, "package"), "--pack-destination", this.root]))
      .trim().split(/\r?\n/u).at(-1);
    if (!packed) throw new Error("npm pack did not report a tarball.");
    await this.run("npm", ["install", "--global", path.join(this.root, packed)]);
    if (!await exists(path.join(this.packageRoot, "WorkbenchBootstrap.mjs"))) {
      throw new Error(`npm did not install @inthedark/wb into the sandbox prefix ${this.npmPrefix}.`);
    }
  }

  private async hostPnpmStore(source: string) {
    // The store is content-addressed; sharing it only avoids re-downloading every dependency.
    try {
      const reported = (await this.run("pnpm", ["store", "path"], { cwd: source, environment: { ...process.env } as Environment })).trim();
      return /^v\d+$/u.test(path.basename(reported)) ? path.dirname(reported) : reported;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.write("Host pnpm not found; the sandbox will use a cold pnpm store.\n");
      return null;
    }
  }

  private async buildEnvironment(hostVpHome: string): Promise<Environment> {
    const environment: Environment = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !HOST_VARIABLES.some(pattern => pattern.test(key))) environment[key] = value;
    }
    const local = windows ? path.join(this.home, "AppData", "Local") : path.join(this.home, ".local", "share");
    const pnpmHome = path.join(local, "pnpm");
    for (const [name, value] of Object.entries({
      HOME: this.home,
      USERPROFILE: this.home,
      ...(windows ? { LOCALAPPDATA: local, APPDATA: path.join(this.home, "AppData", "Roaming") } : {}),
      XDG_CONFIG_HOME: path.join(this.home, ".config"),
      XDG_DATA_HOME: path.join(this.home, ".local", "share"),
      XDG_CACHE_HOME: path.join(this.home, ".cache"),
      XDG_STATE_HOME: path.join(this.home, ".local", "state"),
      VP_HOME: this.vpHome,
      PNPM_HOME: pnpmHome,
      // npm's default global prefix is the Node runtime directory, which is a link to the host's.
      npm_config_prefix: this.npmPrefix,
      // Git likewise must not discover an enclosing repository from inside the sandbox.
      GIT_CEILING_DIRECTORIES: path.dirname(this.root),
      WORKBENCH_INSTALL_REPOSITORY: this.repository,
      WORKBENCH_INSTALL_SANDBOX: this.root,
    })) setVariable(environment, name, value);

    const hostDirectories = new Set([path.join(hostVpHome, "bin"), process.env.PNPM_HOME].filter(Boolean)
      .map(directory => path.resolve(directory!).toLowerCase()));
    const inherited: string[] = [];
    for (const directory of (readVariable(environment, "PATH") ?? "").split(path.delimiter)) {
      if (!directory || hostDirectories.has(path.resolve(directory).toLowerCase())) continue;
      let hostCommand = false;
      for (const name of HOST_COMMANDS.flatMap(commandNames)) {
        if (await exists(path.join(directory, name))) { hostCommand = true; break; }
      }
      if (!hostCommand) inherited.push(directory);
    }
    setVariable(environment, "PATH", [
      windows ? this.npmPrefix : path.join(this.npmPrefix, "bin"),
      path.join(this.vpHome, "bin"),
      path.join(pnpmHome, "bin"),
      ...inherited,
    ].join(path.delimiter));
    return environment;
  }

  private async link(target: string, link: string) {
    if (!await exists(target)) {
      throw new Error(`Host Vite+ is missing ${target}. Run \`vp env install\` in the source checkout first.`);
    }
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, windows ? "junction" : "dir");
    this.links.push(link);
  }

  private async snapshot(source: string) {
    // Copy tracked and unignored files so uncommitted installer changes are what gets installed.
    const files = (await this.run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: source }))
      .split("\0").filter(Boolean);
    const queue = [...new Set(files)];
    await Promise.all(Array.from({ length: 16 }, async () => {
      for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        const from = path.join(source, file);
        const stat = await fs.lstat(from).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat?.isFile()) continue;
        const to = path.join(this.repository, file);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
      }
    }));
    const git = (...args: string[]) => this.run("git", ["-c", "user.name=wb install sandbox", "-c", "user.email=sandbox@localhost",
      "-c", "core.autocrlf=false", ...args], { cwd: this.repository });
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-q", "--no-verify", "-m", "sandbox snapshot of the working tree");
    await fs.copyFile(PRETEND_DISPATCH, path.join(this.repository, "package", "dispatch.mjs"));
    await git("commit", "-q", "--no-verify", "-am", "sandbox: pretend host-level wb commands");
  }

  /** First executable named `name` on the sandbox PATH, or null. */
  async which(name: string) {
    for (const directory of (readVariable(this.environment, "PATH") ?? "").split(path.delimiter)) {
      if (!directory) continue;
      for (const candidate of commandNames(name)) {
        if (await exists(path.join(directory, candidate))) return path.join(directory, candidate);
      }
    }
    return null;
  }

  /** Run a command with the sandbox environment; resolves stdout, rejects with combined output. */
  async run(command: string, args: readonly string[], { cwd = this.home, environment = this.environment }: {
    cwd?: string; environment?: Environment;
  } = {}) {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { errorOutput += String(chunk); });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve(output);
        else reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `status ${code}`}\n${`${output}${errorOutput}`.slice(-4000)}`));
      });
    });
  }

  async dispose() {
    // Detach host links first so recursive removal can never descend into host Vite+ state.
    for (const link of this.links.splice(0).reverse()) {
      await (windows ? fs.rmdir(link) : fs.unlink(link));
    }
    await fs.rm(this.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}
