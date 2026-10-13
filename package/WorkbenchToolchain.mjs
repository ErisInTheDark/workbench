/*
 * Exports:
 * - WorkbenchToolchain (default): persist Vite+ selection and own isolated provisioning and pinned child environments.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";
import resolveWorkbenchDataRoot from "./workbench-data-root.mjs";
import installVitePlus from "./vite-plus-installer.mjs";

const directoryVariables = ["VP_HOME", "VP_BIN_DIR", "VP_DATA_DIR", "VP_CACHE_DIR",
  "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];
const versionVariables = ["VP_NODE_VERSION", "VP_PACKAGE_MANAGER", "VP_NPM_VERSION",
  "VP_PNPM_VERSION", "VP_YARN_VERSION", "VP_BUN_VERSION", "VP_BYPASS"];

export default class WorkbenchToolchain {
  constructor({
    environment = process.env, home = os.homedir(),
    dataRoot = resolveWorkbenchDataRoot({ environment, homeDirectory: home }),
    commands = new WorkbenchBootstrapCommand({ environment }), install = installVitePlus,
  } = {}) {
    this.commands = commands;
    this.environment = environment;
    this.dataRoot = path.resolve(dataRoot);
    this.directory = path.join(this.dataRoot, "installation");
    this.receipt = path.join(this.directory, "toolchain.json");
    this.managedHome = path.join(this.dataRoot, "toolchain");
    this.install = install;
  }

  async read() {
    let text;
    try { text = await fs.readFile(this.receipt, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let record;
    try { record = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid toolchain receipt: ${this.receipt}. It was preserved.`, { cause: error }); }
    if (record?.version !== 1 || typeof record.ready !== "boolean" || !["managed", "external"].includes(record.kind)
      || record.kind === "external" && !record.ready
      || typeof record.executable !== "string" || !path.isAbsolute(record.executable)
      || !record.environment || typeof record.environment !== "object" || Array.isArray(record.environment)
      || Object.keys(record.environment).some(name => !directoryVariables.includes(name))
      || directoryVariables.some(name => !(record.environment[name] === null
        || typeof record.environment[name] === "string" && path.isAbsolute(record.environment[name])))) {
      throw new Error(`Invalid toolchain receipt: ${this.receipt}. It was preserved.`);
    }
    if (record.kind === "managed" && (record.environment.VP_HOME !== this.managedHome
      || record.executable !== this.managedExecutable())) {
      throw new Error(`Managed toolchain receipt points outside its owned location: ${this.receipt}.`);
    }
    return record;
  }

  managedExecutable() {
    return path.join(this.managedHome, "bin", process.platform === "win32" ? "vp.exe" : "vp");
  }

  selection(executable, kind) {
    const environment = Object.fromEntries(directoryVariables.map(name => {
      const value = this.commands.variable(name)?.trim();
      if (value && !path.isAbsolute(value) && name.startsWith("VP_")) {
        throw new Error(`${name} must be an absolute path to persist the Vite+ environment.`);
      }
      return [name, value && path.isAbsolute(value) ? value : null];
    }));
    if (kind === "managed") {
      for (const name of directoryVariables.filter(name => name.startsWith("VP_"))) environment[name] = null;
      environment.VP_HOME = this.managedHome;
    }
    return { version: 1, kind, ready: kind === "external", executable, environment };
  }

  childEnvironment(record, pins) {
    return {
      ...Object.fromEntries(versionVariables.map(name => [name, undefined])),
      ...record.environment,
      WORKBENCH_DATA_ROOT: this.dataRoot,
      ...(pins ? {
        VP_NODE_VERSION: pins.node,
        VP_PACKAGE_MANAGER: `${pins.manager}@${pins.packageManager}`,
        VP_PNPM_VERSION: pins.packageManager,
      } : {}),
    };
  }

  async verify(record) {
    try {
      await this.commands.run(record.executable, ["--version"], {
        environment: this.childEnvironment(record), output: { write() {} }, errorOutput: { write() {} },
      });
    } catch (error) {
      throw new Error(`Recorded Vite+ is unavailable at ${record.executable}. ${record.kind === "external"
        ? "Restore that installation; Workbench will not replace a user-owned toolchain."
        : "Run wb repair to restore the managed toolchain."}`, { cause: error });
    }
  }

  async discover() {
    const executable = await this.commands.findExecutable("vp");
    if (!executable) return null;
    const record = this.selection(executable, "external");
    await this.verify(record);
    return record;
  }

  async resolve() {
    const record = await this.read() ?? await this.discover();
    if (!record) throw new Error("Workbench's Vite+ toolchain is unavailable. Run wb repair.");
    if (!record.ready) throw new Error("Workbench toolchain setup is incomplete. Run wb repair.");
    return record;
  }

  async ensure({ onOutput } = {}) {
    if (this.environment.WORKBENCH_THREAD_ID || this.environment.CODEX_THREAD_ID) {
      throw new Error("Managed threads cannot provision Workbench's toolchain.");
    }
    await fs.mkdir(this.directory, { recursive: true });
    const lock = new DatabaseSync(path.join(this.directory, "toolchain.lock.sqlite3"));
    try {
      try { lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); }
      catch (error) {
        if (error.errcode === 5 || error.errcode === 6) throw new Error("Another Workbench toolchain setup is running. Retry after it finishes.");
        throw error;
      }
      let record = await this.read();
      if (record?.ready) {
        try { await this.verify(record); return record; }
        catch (error) {
          if (record.kind !== "managed") throw error;
          if (error.cause?.code !== "ENOENT") throw error;
        }
      } else if (!record) {
        record = await this.discover();
        if (record) { await this.write(record); return record; }
        record = this.selection(this.managedExecutable(), "managed");
        await this.write(record);
      }
      if (record.ready) {
        record = { ...record, ready: false };
        await this.write(record);
      }
      onOutput?.(`Provisioning Workbench's managed Vite+ at ${this.managedHome}\n`);
      await this.install({ home: this.managedHome, directory: this.directory, commands: this.commands, onOutput });
      await this.verify(record);
      record = { ...record, ready: true };
      await this.write(record);
      return record;
    } finally { lock.close(); }
  }

  async write(record) {
    const temporary = `${this.receipt}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, this.receipt);
  }

  async pins(root) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const runtime = manifest.devEngines?.runtime;
    const manager = manifest.devEngines?.packageManager;
    const exact = value => typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value);
    if (runtime?.name !== "node" || manager?.name !== "pnpm" || !exact(runtime.version) || !exact(manager.version)) {
      throw new Error(`Workbench must declare exact Node and pnpm devEngines pins: ${root}`);
    }
    return { node: runtime.version, manager: manager.name, packageManager: manager.version };
  }

  async run(args, { cwd, ...options }) {
    const [record, pins] = await Promise.all([this.resolve(), this.pins(cwd)]);
    return this.commands.run(record.executable, args, {
      ...options, cwd, environment: { ...options.environment, ...this.childEnvironment(record, pins) },
    });
  }

  async runNode(root, entry, args = [], { nodeOptions = [], ...options } = {}) {
    const [record, pins] = await Promise.all([this.resolve(), this.pins(root)]);
    return this.commands.run(record.executable, [
      "env", "exec", "--node", pins.node, "--package-manager", `${pins.manager}@${pins.packageManager}`,
      "node", ...nodeOptions, entry, ...args,
    ], { ...options, environment: { ...options.environment, ...this.childEnvironment(record, pins) } });
  }
}
