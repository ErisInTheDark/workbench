/*
 * Exports:
 * - LinuxServiceStartup (default): owns the user systemd unit (including its recorded-PATH environment file reference), optional boot enablement and recent unit journal output.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hostEnvironmentFilePath } from "./host-environment-file.ts";
import type { ServiceStartupAdapter, ServiceStartupCommand, ServiceStartupOptions, ServiceStartupStatus } from "./WorkbenchServiceStartup.ts";

/** Recent journal output is diagnostic context for one log line group, not a log export. */
const RECENT_OUTPUT_LINES = 20;
const RECENT_OUTPUT_CHARACTERS = 2048;

// systemd parses each directive differently; every encoder must match its directive's rules.
function specifiers(value: string) {
  if (/[\r\n\u0000]/u.test(value)) throw new Error("Service paths cannot contain control characters.");
  return value.replaceAll("%", "%%");
}
/** Path directives such as WorkingDirectory= are literal apart from specifiers; quotes would become part of the path. */
const pathValue = specifiers;
/** Environment= unquotes and C-unescapes but never expands `$`. */
const environmentValue = (value: string) => `"${specifiers(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
/** ExecStart= additionally expands `$` variables. */
const commandValue = (value: string) => environmentValue(value).replaceAll("$", "$$");

export default class LinuxServiceStartup implements ServiceStartupAdapter {
  private readonly unitPath: string;
  private readonly unitName = "workbench-host.service";

  constructor(private readonly options: ServiceStartupOptions & {
    home: string; nodePath: string; run: ServiceStartupCommand;
  }) {
    this.unitPath = path.join(options.configDirectory ?? process.env.XDG_CONFIG_HOME
      ?? path.join(options.home, ".config"), "systemd", "user", this.unitName);
  }

  async configure(enabled?: boolean) {
    const root = path.resolve(this.options.root);
    const unit = [
      "[Unit]", "Description=Workbench daemon host", "",
      "[Service]", "Type=simple",
      `ExecStart=${commandValue(this.options.nodePath)} ${commandValue(path.join(root, "daemon/host/launch-node.mjs"))}`,
      `WorkingDirectory=${pathValue(root)}`,
      "RuntimeDirectory=workbench-host", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=restart",
      "Environment=WORKBENCH_SERVICE_RUNTIME=%t/workbench-host",
      ...(this.options.dataRoot ? [`Environment=${environmentValue(`WORKBENCH_DATA_ROOT=${this.options.dataRoot}`)}`] : []),
      // Optional: terminal entry points record the user's PATH; systemd rereads it on every host start.
      `EnvironmentFile=-${pathValue(hostEnvironmentFilePath(this.options.dataRoot))}`,
      "KillMode=mixed", "Restart=on-failure", "RestartPreventExitStatus=78",
      "TimeoutStopSec=infinity", "",
      "[Install]", "WantedBy=default.target", "",
    ].join("\n");
    let previous: string | null = null;
    try { previous = await fs.readFile(this.unitPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous !== null && !previous.includes("Description=Workbench daemon host")) {
      throw new Error(`Refusing to replace an unrelated systemd unit at ${this.unitPath}.`);
    }
    if (previous !== unit) {
      await fs.mkdir(path.dirname(this.unitPath), { recursive: true });
      await fs.writeFile(this.unitPath, unit, { mode: 0o600 });
      await this.options.run("systemctl", ["--user", "daemon-reload"]);
    }
    if (enabled) {
      const user = os.userInfo().username;
      let linger = await this.options.run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
      if (linger.trim() !== "yes") {
        await this.options.run("loginctl", ["enable-linger", user]);
        linger = await this.options.run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
        if (linger.trim() !== "yes") throw new Error("User lingering is not enabled. Enable it to keep Workbench wake available after logout.");
      }
    }
    if (enabled !== undefined) {
      await this.options.run("systemctl", ["--user", enabled ? "enable" : "disable", this.unitName]);
    }
  }

  async start() {
    await this.options.run("systemctl", ["--user", "start", this.unitName]);
  }

  /** systemd keeps unit-load and bootstrap failures in the journal, never in the host's own log file. */
  async recentOutput() {
    const output = await this.options.run("journalctl", [
      "--user", "-u", this.unitName, "-n", String(RECENT_OUTPUT_LINES), "--no-pager", "-o", "cat",
    ]);
    const trimmed = output.trim().slice(-RECENT_OUTPUT_CHARACTERS);
    return trimmed || null;
  }

  async status(): Promise<ServiceStartupStatus> {
    const output = await this.options.run("systemctl", [
      "--user", "show", this.unitName, "--property=InvocationID,ExecMainStartTimestampMonotonic,ActiveState,Result",
    ]);
    const values = new Map(output.trim().split("\n").map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }));
    const state = values.get("ActiveState");
    if (!state || !values.has("InvocationID")) throw new Error("systemd did not return the host unit's lifecycle state.");
    return {
      generation: `${values.get("InvocationID")}:${values.get("ExecMainStartTimestampMonotonic") ?? "0"}`,
      phase: state === "active" ? "running" : ["activating", "reloading"].includes(state) ? "starting" : "stopped",
      result: values.get("Result") ?? state,
    };
  }
}
