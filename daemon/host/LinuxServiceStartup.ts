/*
 * Exports:
 * - LinuxServiceStartup (default): owns the user systemd unit and optional boot enablement.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ServiceStartupAdapter, ServiceStartupCommand, ServiceStartupOptions, ServiceStartupStatus } from "./WorkbenchServiceStartup.ts";

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
    const quote = (value: string) => {
      if (/[\r\n\u0000]/u.test(value)) throw new Error("Service paths cannot contain control characters.");
      return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
    };
    const root = path.resolve(this.options.root);
    const unit = [
      "[Unit]", "Description=Workbench daemon host", "",
      "[Service]", "Type=simple",
      `ExecStart=${quote(this.options.nodePath)} ${quote(path.join(root, "daemon/host/launch-node.mjs"))}`,
      `WorkingDirectory=${quote(root)}`,
      "RuntimeDirectory=workbench-host", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=restart",
      "Environment=WORKBENCH_SERVICE_RUNTIME=%t/workbench-host",
      ...(this.options.dataRoot ? [`Environment=${quote(`WORKBENCH_DATA_ROOT=${this.options.dataRoot}`)}`] : []),
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
