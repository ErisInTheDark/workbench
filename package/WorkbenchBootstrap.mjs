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
import SetupCommand from "./SetupCommand.mjs";

export default class WorkbenchBootstrap {
  constructor({
    home = os.homedir(),
    packageRoot = path.dirname(fileURLToPath(import.meta.url)),
    environment = process.env,
    prompt = new WorkbenchInstallPrompt(),
    commands = new SetupCommand(),
    write = text => process.stdout.write(text),
  } = {}) {
    this.home = home;
    this.packageRoot = packageRoot;
    this.environment = environment;
    this.prompt = prompt;
    this.commands = commands;
    this.write = write;
    this.registry = path.join(home, ".workbench", "installation.json");
  }

  async checkoutExists(root) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (manifest.name !== "workbench-root") return false;
      await fs.access(path.join(root, "wb"));
      await fs.access(path.join(root, "package", "setup.mjs"));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
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

  async discardIncomplete(record) {
    const root = path.resolve(record.root);
    if (root !== record.root || !["wb", "workbench"].includes(path.basename(root).toLowerCase())) {
      throw new Error(`Cannot verify failed install destination ${record.root}; it was preserved.`);
    }
    let stat;
    try { stat = await fs.lstat(root); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.unlink(this.registry);
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Failed install destination ${root} is not an ordinary directory; it was preserved.`);
    }
    if (await fs.realpath(root) !== root) {
      throw new Error(`Failed install destination ${root} resolves elsewhere; it was preserved.`);
    }
    if ((await fs.readdir(root)).length) {
      if (!await this.checkoutExists(root)) {
        throw new Error(`Failed install destination ${root} is not a complete Workbench checkout; it was preserved.`);
      }
      const git = await fs.lstat(path.join(root, ".git")).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!git?.isDirectory() || git.isSymbolicLink()) {
        throw new Error(`Failed install destination ${root} is not a regular Git clone; it was preserved.`);
      }
      let changes = "";
      await this.commands.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: root,
        output: { write: bytes => { changes += bytes.toString(); } },
        errorOutput: { write() {} },
      });
      if (changes.trim()) throw new Error(`Failed install destination ${root} has changes; it was preserved.`);
    }
    await fs.rm(root, { recursive: true });
    await fs.unlink(this.registry);
  }

  async run(args) {
    const managed = this.environment.WORKBENCH_THREAD_ID || this.environment.CODEX_THREAD_ID;
    const view = args[0] === "view" && (args.length === 1 || args.length === 2 && ["daemon", "app"].includes(args[1]));
    const humanCommand = view || args.length === 0 || (args.length === 1 && ["connect", "disconnect", "shortcut"].includes(args[0]));
    if (managed && humanCommand) throw new Error("Managed threads cannot install or launch Workbench services.");
    const linked = path.resolve(this.packageRoot, "..");
    if (await this.checkoutExists(linked)) {
      return await this.commands.run("bash", [path.join(linked, "wb"), ...args], { interactive: view });
    }
    const installed = await this.readInstallation();
    if (installed?.phase === "ready") {
      if (!await this.checkoutExists(installed.root)) {
        throw new Error(`Workbench checkout is unavailable at ${installed.root}. Restore or repair that installation; no replacement was created.`);
      }
      return await this.delegate(installed.root, args, humanCommand);
    }
    if (managed || !(args.length === 0 || (args.length === 1 && args[0] === "connect"))) {
      throw new Error("Workbench is not installed. Run wb or wb connect in an interactive terminal first.");
    }
    await this.requireTool("git");
    await this.requireTool("bash");
    await this.requireTool("vp");
    const warning = installed ? `\nNote: Incomplete install attempt at ${installed.root} will be removed.` : "";
    const choice = await this.prompt.choose(
      `Workbench is not installed. This command will clone the repository and run build commands. It may take 1-2 minutes. Continue?${warning}`,
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
      if (latest?.phase === "ready") return await this.delegate(latest.root, args, humanCommand);
      if (latest?.root !== installed?.root || latest?.phase !== installed?.phase) {
        throw new Error("The selected Workbench installation changed while setup was open. Run wb again.");
      }
      if (latest) await this.discardIncomplete(latest);
      await this.requireEmptyDestination(root);
      let record = { version: 1, root, phase: "cloning" };
      await this.writeInstallation(record);
      await this.prompt.withHeader(async () => {
        this.write(`Installing Workbench at ${root}\n`);
        try {
          // Install sandboxes substitute a local snapshot; ordinary installs clone the public repository.
          const repository = this.environment.WORKBENCH_INSTALL_REPOSITORY || "https://github.com/ErisInTheDark/workbench.git";
          await this.commands.run("git", ["clone", "--progress", "--branch", "main", "--single-branch", repository, root]);
          if (!await this.checkoutExists(root)) throw new Error("Clone did not produce a Workbench checkout.");
          record = { ...record, phase: "setup" };
          await this.writeInstallation(record);
          await this.commands.run("vp", ["env", "install"], { cwd: root });
          await this.commands.run("vp", ["node", path.join(root, "package", "setup.mjs"), "--prepare"], { cwd: root });
        } catch (error) {
          try { await this.discardIncomplete(record); }
          catch (cleanupError) {
            throw new Error(`${error.message} Incomplete checkout was preserved at ${root}: ${cleanupError.message}`, { cause: error });
          }
          throw error;
        }
      });
      record = { ...record, phase: "ready" };
      await this.writeInstallation(record);
    } finally {
      // Closing the connection also releases the OS lock after normal completion;
      // process death releases it without a stale PID or lock-file recovery path.
      lock.close();
    }
    // Persist readiness before optional platform actions: missing native artifacts
    // must not turn a usable source installation into an endless setup loop.
    await this.commands.run("vp", ["node", path.join(root, "package", "setup.mjs"),
      args[0] === "connect" ? "--connect" : "--welcome"], { cwd: root, interactive: true });
  }

  async delegate(root, args, humanCommand) {
    if (humanCommand) {
      return await this.commands.run(process.execPath, [path.join(root, "package", "dispatch.mjs"), ...args], { interactive: args[0] === "view" });
    }
    return await this.commands.run("bash", [path.join(root, "wb"), ...args]);
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
