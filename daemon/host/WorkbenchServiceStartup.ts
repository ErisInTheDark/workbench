/*
 * Exports:
 * - ServiceStartupAdapter: platform registration and start boundary.
 * - ServiceStartupCommand/ServiceStartupOptions: platform command and installation inputs.
 * - ServiceStartupStatus: OS-owned run identity and observed lifecycle state.
 * - WorkbenchServiceStartup (default): separates on-demand start from automatic startup.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import WindowsServiceStartup from "./WindowsServiceStartup.ts";
import LinuxServiceStartup from "./LinuxServiceStartup.ts";

export interface ServiceStartupAdapter {
  configure(enabled?: boolean): Promise<void>;
  start(): Promise<void>;
  status(): Promise<ServiceStartupStatus>;
}
export interface ServiceStartupStatus {
  generation: string;
  phase: "stopped" | "starting" | "running";
  result: string;
}
export type ServiceStartupCommand = (command: string, args: readonly string[]) => Promise<string>;
export interface ServiceStartupOptions {
  root: string;
  adapter?: ServiceStartupAdapter;
  platform?: NodeJS.Platform;
  nodePath?: string;
  home?: string;
  configDirectory?: string;
  dataRoot?: string;
  run?: ServiceStartupCommand;
}

function run(command: string, args: readonly string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    child.on("error", error => { failure = error; });
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout = (stdout + data).slice(-65_536); });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(-4096); });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed (${signal ?? code}): ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
}

export default class WorkbenchServiceStartup {
  private readonly adapter: ServiceStartupAdapter;

  constructor(options: ServiceStartupOptions) {
    const platform = options.platform ?? process.platform;
    const resolved = {
      ...options, home: options.home ?? os.homedir(),
      nodePath: options.nodePath ?? process.execPath, run: options.run ?? run,
    };
    if (options.adapter) this.adapter = options.adapter;
    else if (platform === "win32") this.adapter = new WindowsServiceStartup(resolved);
    else if (platform === "linux") this.adapter = new LinuxServiceStartup(resolved);
    else throw new Error(`Daemon startup is not implemented for ${platform}.`);
  }

  async start(enabled?: boolean) {
    await this.adapter.configure(enabled);
    const previous = await this.adapter.status();
    await this.adapter.start();
    return previous.generation;
  }

  async setEnabled(enabled: boolean) {
    await this.adapter.configure(enabled);
    if (enabled) await this.adapter.start();
  }

  status() { return this.adapter.status(); }
}
