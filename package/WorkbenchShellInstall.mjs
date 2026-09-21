/*
 * Exports:
 * - WorkbenchShellInstall (default): publishes owned CLI shell entrypoints.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import SetupCommand from "./SetupCommand.mjs";

const marker = "workbench-owned-shell-entry";

export default class WorkbenchShellInstall {
  constructor({ root, platform = process.platform, bin, commands = new SetupCommand() }) {
    this.root = path.resolve(root);
    this.platform = platform;
    this.bin = bin;
    this.commands = commands;
  }

  async directory() {
    if (this.bin) return this.bin;
    let prefix = "";
    await this.commands.run("npm", ["prefix", "--global"], {
      output: { write: bytes => { prefix += bytes.toString(); } },
    });
    prefix = prefix.trim();
    if (!path.isAbsolute(prefix) || /[\r\n]/u.test(prefix)) throw new Error("npm did not return a valid global prefix.");
    this.bin = this.platform === "win32" ? prefix : path.join(prefix, "bin");
    return this.bin;
  }

  async requireOwned(file) {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(file);
        if (target === path.join(this.root, "package", "wb") || /[/\\]node_modules[/\\]@inthedark[/\\]wb[/\\]wb$/u.test(target)) return;
      } else if (stat.isFile()) {
        const source = await fs.readFile(file, "utf8");
        if (source.includes(marker) || /node_modules[/\\]@inthedark[/\\]wb[/\\]wb/u.test(source)) return;
      }
      throw new Error(`Refusing to replace unrelated CLI entry: ${file}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async preflight() {
    const directory = await this.directory();
    for (const name of this.platform === "win32" ? ["wb", "wb.ps1", "wb.cmd"] : ["wb"]) {
      await this.requireOwned(path.join(directory, name));
    }
  }

  async install() {
    await this.preflight();
    const directory = await this.directory();
    await fs.mkdir(directory, { recursive: true });
    const rootCli = path.join(this.root, "wb").replaceAll("\\", "/");
    const shellLiteral = `'${rootCli.replaceAll("'", "'\\''")}'`;
    const entries = [{
      name: "wb",
      text: `#!/usr/bin/env bash\n# ${marker}\nexec bash ${shellLiteral} "$@"\n`,
    }];
    if (this.platform === "win32") {
      if (/[\r\n"]/u.test(rootCli)) throw new Error("Windows CLI paths cannot contain quotes or line breaks.");
      entries.push({
        name: "wb.ps1",
        text: `# ${marker}\n& bash '${rootCli.replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`,
      }, {
        name: "wb.cmd",
        text: `@echo off\r\nrem ${marker}\r\nbash "${rootCli.replaceAll("%", "%%")}" %*\r\nexit /b %errorlevel%\r\n`,
      });
    }
    for (const entry of entries) {
      const destination = path.join(directory, entry.name);
      const candidate = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(candidate, entry.text, { flag: "wx", mode: 0o755 });
      await this.requireOwned(destination);
      await fs.rename(candidate, destination);
    }
  }
}
