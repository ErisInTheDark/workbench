/*
 * Exports:
 * - WORKBENCH_POWERSHELL_VERSION: pinned managed PowerShell release.
 * - managedPowerShellExecutable: deterministic managed pwsh.exe path for daemon launchers.
 * - WorkbenchPowerShell (default): own verified Windows PowerShell provisioning, receipt and repair.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import WorkbenchBootstrapCommand from "./WorkbenchBootstrapCommand.mjs";
import resolveWorkbenchDataRoot from "./workbench-data-root.mjs";
import installPowerShell, { POWERSHELL_RELEASES } from "./powershell-installer.mjs";

export const WORKBENCH_POWERSHELL_VERSION = POWERSHELL_RELEASES.x64.version;

function managedReleaseExecutable(dataRoot, release, arch) {
  return path.join(path.resolve(dataRoot), "toolchain", "powershell", release, arch, "pwsh.exe");
}

export function managedPowerShellExecutable(dataRoot, arch = process.arch) {
  return managedReleaseExecutable(dataRoot, WORKBENCH_POWERSHELL_VERSION, arch);
}

export default class WorkbenchPowerShell {
  constructor({
    environment = process.env,
    dataRoot = resolveWorkbenchDataRoot({ environment }),
    platform = process.platform,
    arch = process.arch,
    commands = new WorkbenchBootstrapCommand({ environment }),
    install = installPowerShell,
    files = fs,
  } = {}) {
    this.environment = environment;
    this.dataRoot = path.resolve(dataRoot);
    this.platform = platform;
    this.arch = arch;
    this.commands = commands;
    this.install = install;
    this.files = files;
    this.directory = path.join(this.dataRoot, "installation");
    this.receipt = path.join(this.directory, "powershell.json");
    this.home = path.dirname(this.executable());
  }

  executable() {
    return managedPowerShellExecutable(this.dataRoot, this.arch);
  }

  record(ready) {
    return {
      version: 1,
      ready,
      release: WORKBENCH_POWERSHELL_VERSION,
      arch: this.arch,
      executable: this.executable(),
    };
  }

  async read() {
    let text;
    try { text = await this.files.readFile(this.receipt, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let record;
    try { record = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid PowerShell receipt: ${this.receipt}. It was preserved.`, { cause: error }); }
    if (record?.version !== 1 || typeof record.ready !== "boolean"
      || typeof record.release !== "string" || !/^\d+\.\d+\.\d+$/u.test(record.release)
      || !["x64", "arm64"].includes(record.arch)
      || typeof record.executable !== "string" || !path.isAbsolute(record.executable)) {
      throw new Error(`Invalid PowerShell receipt: ${this.receipt}. It was preserved.`);
    }
    const expected = managedReleaseExecutable(this.dataRoot, record.release, record.arch);
    if (record.executable !== expected) {
      throw new Error(`Managed PowerShell receipt points outside its owned location: ${this.receipt}.`);
    }
    return record;
  }

  async verify(executable = this.executable()) {
    let output = "";
    try {
      await this.commands.run(executable, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        output: { write: bytes => { output += bytes.toString(); } },
        errorOutput: { write() {} },
      });
    } catch (error) {
      throw new Error(`Workbench PowerShell is unavailable at ${executable}. Run wb repair to restore it.`, { cause: error });
    }
    if (String(output).trim() !== WORKBENCH_POWERSHELL_VERSION) {
      throw new Error(`Workbench PowerShell at ${executable} reported ${String(output).trim() || "no version"}; expected ${WORKBENCH_POWERSHELL_VERSION}. Run wb repair.`);
    }
  }

  async resolve() {
    if (this.platform !== "win32") return null;
    const record = await this.read();
    if (!record?.ready || record.release !== WORKBENCH_POWERSHELL_VERSION || record.arch !== this.arch) {
      throw new Error("Workbench PowerShell setup is incomplete. Run wb repair.");
    }
    await this.verify(record.executable);
    return record.executable;
  }

  async ensure({ onOutput } = {}) {
    if (this.platform !== "win32") return null;
    if (this.environment.WORKBENCH_THREAD_ID || this.environment.CODEX_THREAD_ID) {
      throw new Error("Managed threads cannot provision Workbench PowerShell.");
    }
    if (!POWERSHELL_RELEASES[this.arch]) {
      throw new Error(`Workbench PowerShell is not available for Windows ${this.arch}.`);
    }
    await this.files.mkdir(this.directory, { recursive: true });
    const lock = new DatabaseSync(path.join(this.directory, "powershell.lock.sqlite3"));
    try {
      try { lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); }
      catch (error) {
        if (error.errcode === 5 || error.errcode === 6) throw new Error("Another Workbench PowerShell setup is running. Retry after it finishes.");
        throw error;
      }
      const current = await this.read();
      if (current?.ready && current.release === WORKBENCH_POWERSHELL_VERSION && current.arch === this.arch) {
        try { await this.verify(current.executable); return current.executable; }
        catch (error) {
          onOutput?.(`Repairing Workbench PowerShell after verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      await this.write(this.record(false));
      const staging = `${this.home}.staging-${randomUUID()}`;
      try {
        await this.files.rm(this.home, { recursive: true, force: true });
        await this.files.rm(staging, { recursive: true, force: true });
        onOutput?.(`Provisioning Workbench PowerShell ${WORKBENCH_POWERSHELL_VERSION} at ${this.home}\n`);
        await this.install({
          destination: staging,
          directory: this.directory,
          commands: this.commands,
          onOutput,
          arch: this.arch,
          files: this.files,
        });
        const stagedExecutable = path.join(staging, "pwsh.exe");
        await this.verify(stagedExecutable);
        await this.files.mkdir(path.dirname(this.home), { recursive: true });
        await this.files.rename(staging, this.home);
        await this.verify();
        await this.write(this.record(true));
        if (current && current.executable !== this.executable()) {
          try { await this.files.rm(path.dirname(current.executable), { recursive: true, force: true }); }
          catch (error) {
            onOutput?.(`Workbench PowerShell ${WORKBENCH_POWERSHELL_VERSION} is ready, but its retired runtime could not be removed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        return this.executable();
      } catch (error) {
        try { await this.files.rm(staging, { recursive: true, force: true }); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `PowerShell setup failed and staging could not be removed: ${staging}`, { cause: error });
        }
        throw error;
      }
    } finally {
      lock.close();
    }
  }

  async write(record) {
    const temporary = `${this.receipt}.${randomUUID()}.tmp`;
    await this.files.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await this.files.rename(temporary, this.receipt);
  }
}
