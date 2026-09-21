/*
 * Exports:
 * - WorkbenchDesktopLauncherOptions: checkout desktop artifact and process boundaries.
 * - default WorkbenchDesktopLauncher: launch and install the committed native tray shell.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import LinuxDesktopShortcut from "./LinuxDesktopShortcut.ts";

interface CommandOptions {
  cwd: string;
  detached?: boolean;
  stdio: "ignore" | "inherit";
  windowsHide: boolean;
}

export interface WorkbenchDesktopLauncherOptions {
  launchDetached?: (command: string, args: string[], options: CommandOptions) => Promise<void>;
  pathExists?: (filePath: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: string;
  repositoryRootPath: string;
  runCommand?: (command: string, args: string[], options: CommandOptions) => Promise<void>;
}

function runCommand(command: string, args: string[], options: CommandOptions) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}.`));
    });
  });
}

function launchDetached(command: string, args: string[], options: CommandOptions) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export default class WorkbenchDesktopLauncher {
  private readonly launchDetached: NonNullable<WorkbenchDesktopLauncherOptions["launchDetached"]>;
  private readonly pathExists: NonNullable<WorkbenchDesktopLauncherOptions["pathExists"]>;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly repositoryRootPath: string;
  private readonly runCommand: NonNullable<WorkbenchDesktopLauncherOptions["runCommand"]>;

  constructor(options: WorkbenchDesktopLauncherOptions) {
    this.launchDetached = options.launchDetached ?? launchDetached;
    this.pathExists = options.pathExists ?? pathExists;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.repositoryRootPath = path.resolve(options.repositoryRootPath);
    this.runCommand = options.runCommand ?? runCommand;
  }

  async start() {
    this.requirePlatform();
    const launcherPath = await this.requireLauncher();
    await this.launchDetached(launcherPath, ["--workbench-root", this.repositoryRootPath], {
      cwd: this.repositoryRootPath,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  }

  async installShortcut() {
    this.requirePlatform();
    const launcherPath = await this.requireLauncher();
    if (this.platform === "linux") {
      await new LinuxDesktopShortcut({ root: this.repositoryRootPath, launcher: launcherPath }).install();
      return;
    }
    await this.runCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(this.repositoryRootPath, "app", "server", "install-workbench-shortcut.ps1"),
      "-LauncherPath",
      launcherPath,
      "-WorkbenchRoot",
      this.repositoryRootPath,
    ], {
      cwd: this.repositoryRootPath,
      stdio: "inherit",
      windowsHide: false,
    });
  }

  private async requireLauncher() {
    const launcherPath = path.join(
      this.repositoryRootPath,
      "app", "tray",
      "bin",
      `${this.platform === "win32" ? "windows" : "linux"}-${this.arch}`,
      this.platform === "win32" ? "workbench-tray.exe" : "workbench-tray",
    );
    if (!await this.pathExists(launcherPath)) {
      throw new Error(
        `Workbench tray launcher is missing at ${launcherPath}. Restore the committed artifact or run pnpm build:tray from the repository root.`,
      );
    }
    return launcherPath;
  }

  private requirePlatform() {
    if (this.platform !== "win32" && this.platform !== "linux") {
      throw new Error("Workbench desktop launch supports Windows and Linux.");
    }
  }
}
