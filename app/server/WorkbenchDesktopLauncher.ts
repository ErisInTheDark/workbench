/*
 * Exports:
 * - TRAY_READY_SENTINEL: readiness record the launcher waits for before handing off tray ownership.
 * - WorkbenchDesktopLauncherOptions: checkout desktop artifact, process and startup handoff boundaries.
 * - default WorkbenchDesktopLauncher: launch and install a staged copy of the committed native tray shell, reporting startup failure.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import NativeArtifactStage, { type NativeArtifactStager } from "workbench-shared/process/NativeArtifactStage";
import LinuxDesktopShortcut from "./LinuxDesktopShortcut.ts";

interface CommandOptions {
  cwd: string;
  detached?: boolean;
  stdio: "ignore" | "inherit";
  windowsHide: boolean;
}

/** The tray prints this once Tauri setup built its icon and started the app child. */
export const TRAY_READY_SENTINEL = "\u001eWORKBENCH_TRAY_V1 READY";
/** Anti-hang handoff: a living tray is never failed by this bound, it only stops observation. */
const STARTUP_HANDOFF_MS = 3_000;
const MAX_STARTUP_OUTPUT = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

export interface WorkbenchDesktopLauncherOptions {
  pathExists?: (filePath: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: string;
  repositoryRootPath: string;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Schedules the startup handoff and returns a canceller; injectable so tests avoid real timers. */
  startupHandoff?: (handoff: () => void) => () => void;
  stage?: NativeArtifactStager;
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

function startupHandoff(handoff: () => void) {
  const timer = setTimeout(handoff, STARTUP_HANDOFF_MS);
  return () => clearTimeout(timer);
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

function startupFailure(code: number | null, signal: NodeJS.Signals | null, diagnostics: string) {
  const status = signal ? `signal ${signal}` : `status ${code ?? "unknown"}`;
  const detail = diagnostics.replace(CONTROL_CHARACTERS, "").trim();
  return `Workbench tray exited during startup (${status}).${detail ? `\n${detail}` : ""}`;
}

export default class WorkbenchDesktopLauncher {
  private readonly pathExists: NonNullable<WorkbenchDesktopLauncherOptions["pathExists"]>;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly repositoryRootPath: string;
  private readonly spawnProcess: NonNullable<WorkbenchDesktopLauncherOptions["spawnProcess"]>;
  private readonly startupHandoff: NonNullable<WorkbenchDesktopLauncherOptions["startupHandoff"]>;
  private readonly stage: NativeArtifactStager;
  private readonly runCommand: NonNullable<WorkbenchDesktopLauncherOptions["runCommand"]>;

  constructor(options: WorkbenchDesktopLauncherOptions) {
    this.pathExists = options.pathExists ?? pathExists;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.repositoryRootPath = path.resolve(options.repositoryRootPath);
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.startupHandoff = options.startupHandoff ?? startupHandoff;
    this.stage = options.stage ?? new NativeArtifactStage();
    this.runCommand = options.runCommand ?? runCommand;
  }

  async start() {
    this.requirePlatform();
    const launcherPath = await this.requireLauncher();
    await this.launch(launcherPath);
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

  /**
   * Launch the tray and keep enough of it attached to distinguish readiness from an immediate
   * death. A tray that exits before signalling readiness rejects with its captured output; a
   * living tray hands off once it signals readiness or the anti-hang handoff elapses.
   */
  private launch(command: string) {
    return new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(command, ["--workbench-root", this.repositoryRootPath], {
        cwd: this.repositoryRootPath,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let diagnostics = "";
      let stdoutWindow = "";
      let settled = false;
      let cancelHandoff: () => void = () => {};
      const settle = (failure?: Error) => {
        if (settled) return;
        settled = true;
        cancelHandoff();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        if (failure) reject(failure);
        else resolve();
      };
      const record = (text: string) => {
        if (diagnostics.length < MAX_STARTUP_OUTPUT) diagnostics = (diagnostics + text).slice(0, MAX_STARTUP_OUTPUT);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        record(text);
        stdoutWindow = (stdoutWindow + text).slice(-TRAY_READY_SENTINEL.length * 2);
        if (stdoutWindow.includes(TRAY_READY_SENTINEL)) settle();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => record(chunk.toString()));
      child.once("error", error => settle(error instanceof Error ? error : new Error(String(error))));
      child.once("exit", (code, signal) => settle(new Error(startupFailure(code, signal, diagnostics))));
      cancelHandoff = this.startupHandoff(() => settle());
      if (settled) cancelHandoff();
    });
  }

  private async requireLauncher() {
    const committed = path.join(
      this.repositoryRootPath,
      "app", "tray",
      "bin",
      `${this.platform === "win32" ? "windows" : "linux"}-${this.arch}`,
      this.platform === "win32" ? "workbench-tray.exe" : "workbench-tray",
    );
    if (!await this.pathExists(committed)) {
      throw new Error(
        `Workbench tray launcher is missing at ${committed}. Restore the committed artifact or run pnpm build:tray from the repository root.`,
      );
    }
    return await this.stage.stage({ label: "tray", executable: committed });
  }

  private requirePlatform() {
    if (this.platform !== "win32" && this.platform !== "linux") {
      throw new Error("Workbench desktop launch supports Windows and Linux.");
    }
  }
}
