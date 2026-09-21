/*
 * Exports:
 * - WindowsServiceStartup (default): owns a current-user scheduled host task outside the app's job.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";
import type { ServiceStartupAdapter, ServiceStartupCommand, ServiceStartupOptions, ServiceStartupStatus } from "./WorkbenchServiceStartup.ts";

export default class WindowsServiceStartup implements ServiceStartupAdapter {
  private readonly user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
  private readonly taskName = `WorkbenchHost-${createHash("sha256").update(this.user.toLowerCase()).digest("hex").slice(0, 16)}`;

  constructor(private readonly options: ServiceStartupOptions & {
    home: string; nodePath: string; run: ServiceStartupCommand;
  }) {}

  async configure(enabled?: boolean) {
    const root = path.resolve(this.options.root);
    const dataRoot = this.options.dataRoot ?? resolveWorkbenchDataRoot();
    const launcher = path.join(root, "daemon/host/bin", `windows-${process.arch}`, "workbench-daemon-host.exe");
    try { await fs.access(launcher); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Workbench host binary is missing. Run pnpm build:host from ${root}, then retry.`);
    }
    if (enabled === undefined) {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$taskError = @()",
        `$task = Get-ScheduledTask -TaskName '${this.taskName}' -ErrorAction SilentlyContinue -ErrorVariable taskError`,
        "foreach ($failure in $taskError) { if ($failure.CategoryInfo.Category -ne 'ObjectNotFound') { throw $failure } }",
        "if ($null -eq $task) { @{ enabled = $false } | ConvertTo-Json -Compress }",
        "else { @{ enabled = [bool](@($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled }).Count) } | ConvertTo-Json -Compress }",
      ].join("\n");
      const output = await this.options.run("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ]);
      enabled = z.object({ enabled: z.boolean() }).parse(JSON.parse(output)).enabled;
    }
    const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
    const argument = (value: string) => `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/\\+$/u, "$&$&")}"`;
    const contents = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "<RegistrationInfo><Description>Workbench daemon host</Description></RegistrationInfo>",
      enabled ? `<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(this.user)}</UserId></LogonTrigger></Triggers>` : "<Triggers/>",
      `<Principals><Principal id="User"><UserId>${xml(this.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>",
      `<Actions Context="User"><Exec><Command>${xml(launcher)}</Command><Arguments>${xml(`${argument(root)} ${argument(this.options.nodePath)} ${argument(dataRoot)}`)}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>`,
      "</Task>",
    ].join("\r\n");
    const directory = path.join(dataRoot, "service");
    const taskPath = path.join(directory, "startup-task.xml");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(taskPath, `\ufeff${contents}`, "utf16le");
    // Scheduler ownership prevents the host inheriting the app's kill-on-close job.
    // A task without triggers is still available for explicit on-demand starts.
    await this.options.run("schtasks.exe", ["/Create", "/TN", this.taskName, "/XML", taskPath, "/F"]);
  }

  async start() {
    await this.options.run("schtasks.exe", ["/Run", "/TN", this.taskName]);
  }

  async status(): Promise<ServiceStartupStatus> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$task = Get-ScheduledTask -TaskName '${this.taskName}'`,
      "$info = $task | Get-ScheduledTaskInfo",
      "@{ state = $task.State.ToString(); generation = $info.LastRunTime.Ticks.ToString(); result = $info.LastTaskResult.ToString() } | ConvertTo-Json -Compress",
    ].join("\n");
    const output = await this.options.run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ]);
    const value = z.object({ state: z.string(), generation: z.string(), result: z.string() }).parse(JSON.parse(output));
    return {
      generation: value.generation,
      phase: value.state === "Running" ? "running" : value.state === "Queued" ? "starting" : "stopped",
      result: value.result,
    };
  }
}
