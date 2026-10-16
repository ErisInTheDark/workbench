/*
 * Exports:
 * - WorkbenchBootstrap (default): locates or installs an editable checkout and delegates to it.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WorkbenchInstallPrompt from "./WorkbenchInstallPrompt.mjs";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";
import WorkbenchToolchain from "./WorkbenchToolchain.mjs";
import WorkbenchPackageRegistration from "./WorkbenchPackageRegistration.mjs";
import resolveWorkbenchDataRoot from "./workbench-data-root.mjs";

export default class WorkbenchBootstrap {
  constructor({
    home = os.homedir(),
    packageRoot = path.dirname(fileURLToPath(import.meta.url)),
    environment = process.env,
    platform = process.platform,
    prompt = new WorkbenchInstallPrompt(),
    commands = new WorkbenchBootstrapCommand({ environment }),
    toolchain = new WorkbenchToolchain({ home, environment, commands }),
    registration = new WorkbenchPackageRegistration({ home, environment, packageRoot }),
    write = text => process.stdout.write(text),
  } = {}) {
    this.home = home;
    this.packageRoot = packageRoot;
    this.environment = environment;
    this.platform = platform;
    this.prompt = prompt;
    this.commands = commands;
    this.toolchain = toolchain;
    this.registration = registration;
    this.write = write;
    this.registry = path.join(
      resolveWorkbenchDataRoot({ environment, homeDirectory: home, platform }),
      "installation", "installation.json",
    );
  }

  async checkoutExists(root) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (manifest.name !== "workbench-root") return false;
      await fs.access(path.join(root, "wb"));
      await fs.access(path.join(root, "scripts", "install.mjs"));
      await fs.access(path.join(root, "cli", "dispatch.mjs"));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async checkoutState(root) {
    if (await this.checkoutExists(root)) return "usable";
    try {
      await fs.lstat(root);
      return "invalid";
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }

  async readInstallation() {
    try {
      const record = JSON.parse(await fs.readFile(this.registry, "utf8"));
      if (record.version !== 1 || typeof record.root !== "string" || !path.isAbsolute(record.root)
        || !["cloning", "setup", "ready"].includes(record.phase)) {
        throw new Error(`Invalid Workbench installation record: ${this.registry}. Existing files were not changed.`);
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeInstallation(record) {
    const candidate = `${this.registry}.${randomUUID()}.tmp`;
    await fs.writeFile(candidate, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(candidate, this.registry);
  }

  async requireTool(command, cwd) {
    try {
      await this.commands.run(command, ["--version"], {
        cwd,
        output: { write() {} },
        errorOutput: { write() {} },
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(`${command} is required to install Workbench. Install it and make it available on PATH, then retry.`, { cause: error });
    }
  }

  async run(args) {
    const managed = this.environment.WORKBENCH_THREAD_ID || this.environment.CODEX_THREAD_ID;
    const view = args[0] === "view" && (args.length === 1 || args.length === 2 && ["daemon", "app"].includes(args[1]));
    const humanCommand = view || args.length === 0 || (args.length === 1 && ["connect", "disconnect", "shortcut"].includes(args[0]));
    if (managed && humanCommand) throw new Error("Managed threads cannot install or launch Workbench services.");
    const linked = path.resolve(this.packageRoot, "..");
    if (await this.checkoutExists(linked)) {
      return await this.delegate(linked, args);
    }
    const installed = await this.readInstallation();
    if (installed?.phase === "ready") {
      const state = await this.checkoutState(installed.root);
      if (state === "usable") return await this.delegate(installed.root, args);
      if (state === "invalid") {
        throw new Error(`Workbench checkout is unavailable at ${installed.root}. Restore or repair that installation; no replacement was created.`);
      }
    }
    if (managed || !(args.length === 0 || (args.length === 1 && args[0] === "connect"))) {
      throw new Error("Workbench is not installed. Run wb or wb connect in an interactive terminal first.");
    }
    await this.requireTool("git");
    await this.requireTool("bash");
    const warning = installed?.phase === "ready"
      ? `\nNote: Previous installation at ${installed.root} no longer exists and will be recreated.`
      : installed ? `\nResuming incomplete install at ${installed.root}.` : "";
    const choice = await this.prompt.choose(
      `Workbench is not installed. This command will provision a private Vite+ toolchain if needed, clone the repository, run build commands, and register wb through your package manager. Continue?${warning}`,
      ["Let's go!", "Cancel"],
    );
    if (choice !== "Let's go!") throw new DOMException("Setup cancelled.", "AbortError");
    const defaultRoot = installed?.root ?? (process.platform === "win32"
      ? path.join(this.environment.LOCALAPPDATA || path.join(this.home, "AppData", "Local"), "Programs", "inthedark", "wb")
      : path.join(this.home, ".local", "lib", "inthedark", "wb"));
    const root = path.resolve(await this.prompt.location("Install location", defaultRoot));
    await fs.mkdir(path.dirname(this.registry), { recursive: true });
    const lockPath = `${this.registry}.lock.sqlite3`;
    const lock = new DatabaseSync(lockPath);
    try {
      lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      if (error.errcode === 5 || error.errcode === 6) {
        throw new Error("Another Workbench installation is running. Let it finish before trying again.");
      }
      throw error;
    }
    try {
      // Another invocation may have finished while this one was accepting input.
      const latest = await this.readInstallation();
      if (latest?.phase === "ready") {
        const state = await this.checkoutState(latest.root);
        if (state === "usable") return await this.delegate(latest.root, args);
        if (state === "invalid") {
          throw new Error(`Workbench checkout is unavailable at ${latest.root}. Restore or repair that installation; no replacement was created.`);
        }
      }
      if (latest?.root !== installed?.root || latest?.phase !== installed?.phase) {
        throw new Error("The selected Workbench installation changed while setup was open. Run wb again.");
      }
      const resume = latest?.root === root && await this.checkoutExists(root);
      if (!resume) await this.requireEmptyDestination(root);
      // Recording before provisioning keeps the chosen location as the next default if anything fails.
      await this.writeInstallation({ version: 1, root, phase: resume ? "setup" : "cloning" });
      await this.registration.prepare();
      await this.toolchain.ensure();
      await this.prompt.withHeader(async () => {
        this.write(`${resume ? "Resuming" : "Installing"} Workbench at ${root}\n`);
        if (!resume) {
          // Install sandboxes substitute a local snapshot; ordinary installs clone the public repository.
          const repository = this.environment.WORKBENCH_INSTALL_REPOSITORY || "https://github.com/ErisInTheDark/workbench.git";
          await this.commands.run("git", ["clone", "--progress", "--branch", "main", "--single-branch", repository, root]);
          if (!await this.checkoutExists(root)) throw new Error("Clone did not produce a Workbench checkout.");
          await this.writeInstallation({ version: 1, root, phase: "setup" });
        }
        await this.commands.run(process.execPath, [path.join(root, "scripts", "install.mjs"), "--prepare"], { cwd: root });
        await this.registration.register(root);
      });
      await this.writeInstallation({ version: 1, root, phase: "ready" });
    } finally {
      // Closing the connection also releases the OS lock after normal completion;
      // process death releases it without a stale PID or lock-file recovery path.
      lock.close();
    }
    // Persist readiness before optional platform actions: missing native artifacts
    // must not turn a usable source installation into an endless setup loop.
    await this.commands.run(process.execPath, [path.join(root, "scripts", "install.mjs"),
      args[0] === "connect" ? "--connect" : "--welcome"], { cwd: root, interactive: true });
  }

  async delegate(root, args) {
    return await this.commands.run(process.execPath, [path.join(root, "cli", "dispatch.mjs"), ...args], { interactive: true });
  }

  async requireEmptyDestination(root) {
    try {
      if ((await fs.readdir(root)).length) throw new Error(`Installation destination must be empty: ${root}. Existing files were preserved.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.access(path.dirname(root), constants.W_OK);
  }
}
