/*
 * Exports:
 * - WorkbenchPackageRegistration (default): capture the invoking package manager and register wb in its public global bin.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";

const managers = {
  npm: {
    binArgs: ["prefix", "--global"],
    packageArgs: ["root", "--global"],
    packagePaths: roots => roots.map(root => path.join(root, "@inthedark", "wb")),
    bin: prefix => process.platform === "win32" ? prefix : path.join(prefix, "bin"),
    install: (root, prefix) => ["install", "--global", "--prefix", prefix, path.join(root, "package")],
  },
  pnpm: {
    binArgs: ["bin", "--global"],
    packageArgs: ["list", "--global", "--parseable", "@inthedark/wb"],
    packagePaths: roots => roots.slice(1),
    bin: directory => directory,
    install: root => ["add", "--global", path.join(root, "package")],
  },
};

export default class WorkbenchPackageRegistration {
  constructor({
    environment = process.env, home = os.homedir(), nodePath = process.execPath,
    packageRoot = path.dirname(fileURLToPath(import.meta.url)),
    commands = new WorkbenchBootstrapCommand({ environment: { ...environment } }),
  } = {}) {
    this.commands = commands;
    this.home = home;
    this.nodePath = nodePath;
    this.packageRoot = packageRoot;
  }

  async capture() {
    const userAgent = this.commands.variable("npm_config_user_agent");
    const identity = userAgent?.match(/^([a-z]+)(?:\/|\s|$)/iu)?.[1]?.toLowerCase();
    const entry = this.commands.variable("npm_execpath");
    const entryIdentity = entry && /(?:^|[/\\])(npm-cli\.js|npx-cli\.js|pnpm(?:\.cjs|\.js|\.exe)?)$/iu.exec(entry)?.[1];
    const identified = entryIdentity && (entryIdentity.toLowerCase().startsWith("pnpm") ? "pnpm" : "npm");
    if (identity && !Object.hasOwn(managers, identity)) {
      throw new Error(`Automatic wb registration supports npm and pnpm, not ${identity}. Run npx @inthedark/wb or pnpm dlx @inthedark/wb.`);
    }
    if (identity && identified && identity !== identified) {
      throw new Error("Invoking package-manager metadata conflicts. Run Workbench directly with npx or pnpm dlx.");
    }
    const name = identity ?? identified ?? "npm";
    let command;
    if (entry && identified === name) {
      if (!path.isAbsolute(entry)) throw new Error("Invoking package-manager executable must be an absolute path.");
      await fs.access(entry);
      command = /\.(?:cjs|mjs|js)$/iu.test(entry) ? [this.nodePath, entry] : [entry];
    } else {
      command = await this.commands.resolve(name);
    }
    return { name, command };
  }

  async execute(selection, args, options = {}) {
    const [command, ...prefix] = selection.command;
    return this.commands.run(command, [...prefix, ...args], { cwd: this.home, ...options });
  }

  async reportPaths(selection, args) {
    let output = "";
    await this.execute(selection, args, { output: { write: bytes => { output += bytes.toString(); } } });
    const locations = output.trim().split(/\r?\n/u);
    if (locations.some(location => !location || !path.isAbsolute(location))) {
      throw new Error(`${selection.name} did not report absolute global installation paths.`);
    }
    return locations;
  }

  async destination(selection) {
    const locations = await this.reportPaths(selection, managers[selection.name].binArgs);
    if (locations.length !== 1) throw new Error(`${selection.name} reported more than one global bin directory.`);
    const [location] = locations;
    return { prefix: location, bin: managers[selection.name].bin(location) };
  }

  async checkWritable(directory) {
    let current = directory;
    while (true) {
      try {
        await fs.access(current, constants.W_OK);
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`The package manager's global bin is not writable: ${directory}. Fix its permissions or configure a user-owned global prefix.`, { cause: error });
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }

  samePath(left, right) {
    const normalise = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    return normalise(left) === normalise(right);
  }

  async publicCommand(bin) {
    for (const name of process.platform === "win32" ? ["wb.exe", "wb.cmd", "wb.bat", "wb"] : ["wb"]) {
      const candidate = path.join(bin, name);
      try {
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }
    return null;
  }

  async checkExistingCommand(bin) {
    const command = await this.publicCommand(bin);
    if (!command) return;
    const manager = managers[this.selection.name];
    const roots = await this.reportPaths(this.selection, manager.packageArgs);
    for (const packageRoot of manager.packagePaths(roots)) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
        if (manifest.name === "@inthedark/wb" && manifest.bin?.wb === "wb") {
          await fs.access(path.join(packageRoot, "wb"));
          return;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error(`The global bin already contains ${command}, but ${this.selection.name} does not own a Workbench package there. Resolve that conflict before installing.`);
  }

  async checkPath(bin) {
    const directories = (this.commands.variable("PATH") || "").split(path.delimiter).filter(Boolean);
    if (!directories.some(directory => this.samePath(directory, bin))) {
      throw new Error(`${bin} is ${this.selection.name}'s global bin but is not on PATH. Add that directory to your PATH, open a new terminal, and retry.`);
    }
    const names = process.platform === "win32" ? ["wb.exe", "wb.cmd", "wb.bat", "wb"] : ["wb"];
    const ownEntry = await fs.realpath(path.join(this.packageRoot, "wb"));
    for (const directory of directories) {
      if (this.samePath(directory, bin)) {
        await this.checkExistingCommand(bin);
        return;
      }
      for (const name of names) {
        const candidate = path.join(directory, name);
        let target;
        try { target = await fs.realpath(candidate); }
        catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
        if (this.samePath(target, ownEntry)) continue;
        // npm's npx Windows wrappers sit beside the package's node_modules entry.
        const injected = path.join(directory, "..", "@inthedark", "wb", "wb");
        try {
          if (this.samePath(await fs.realpath(injected), ownEntry)) continue;
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
        throw new Error(`Another wb command at ${candidate} precedes ${bin} on PATH. Resolve that conflict before installing; it was not changed.`);
      }
    }
  }

  async prepare() {
    const selection = await this.capture();
    const destination = await this.destination(selection);
    this.selection = { ...selection, ...destination };
    await this.checkPath(destination.bin);
    await this.checkWritable(destination.bin);
  }

  async register(root) {
    if (!this.selection) throw new Error("Package registration must be checked before installing Workbench.");
    const current = await this.destination(this.selection);
    if (!this.samePath(current.bin, this.selection.bin) || !this.samePath(current.prefix, this.selection.prefix)) {
      throw new Error("The package manager's global destination changed during installation. Run Workbench again.");
    }
    await this.execute(this.selection, managers[this.selection.name].install(root, this.selection.prefix));
    if (!await this.publicCommand(this.selection.bin)) throw new Error(`${this.selection.name} did not register the public wb command in ${this.selection.bin}.`);
    await this.checkPath(this.selection.bin);
  }
}
