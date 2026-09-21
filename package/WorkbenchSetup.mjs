/*
 * Exports:
 * - WorkbenchSetup (default): checkout-owned dependency setup and first-run actions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchInstallPrompt from "./WorkbenchInstallPrompt.mjs";
import WorkbenchShellInstall from "./WorkbenchShellInstall.mjs";
import SetupCommand from "./SetupCommand.mjs";

export default class WorkbenchSetup {
  constructor({
    root,
    commands = new SetupCommand(),
    prompt = new WorkbenchInstallPrompt(),
    shellInstall,
    detectTailscale,
    write = text => process.stdout.write(text),
  }) {
    this.root = root;
    this.commands = commands;
    this.prompt = prompt;
    this.shellInstall = shellInstall ?? new WorkbenchShellInstall({ root, commands });
    this.detectTailscale = detectTailscale ?? (() => this.hasTailscale());
    this.write = write;
  }

  async prepare() {
    await this.shellInstall.preflight();
    this.write("Building dependencies...\n");
    await this.commands.run("pnpm", ["install"], { cwd: this.root });
    this.write("Building frontend...\n");
    await this.commands.run("pnpm", ["build:app"], { cwd: this.root });
    this.write("Installing Workbench CLI...\n");
    await this.commands.run("npm", ["install", "--global", path.join(this.root, "package")], { cwd: this.root });
    await this.shellInstall.install();
    this.write("Setup complete.\n");
  }

  async welcome() {
    if (await this.detectTailscale()) {
      const choice = await this.prompt.choose(
        "Workbench has an APP and a DAEMON background service. Running the app will automatically launch the daemon. If you're on a shared network with Tailscale, your app can connect to other daemons when their apps are not running. This requires a thin wake service to run on the device, allowing other apps to find it.\n\nDo you want to connect to this daemon from the workbench app on other devices?",
        ["Enable wake service", "Skip"],
      );
      if (choice === "Enable wake service") await this.connect();
    }
    const shortcut = await this.prompt.choose("Add a desktop shortcut?", ["Add shortcut", "Skip"]);
    if (shortcut === "Add shortcut") await this.dispatch(["shortcut"]);
    this.write([
      "Workbench CLI:",
      "  wb - launch",
      "  wb connect - enable wake service",
      "  wb disconnect - disable wake service",
      ...(shortcut === "Add shortcut" ? [] : ["  wb shortcut - add a desktop shortcut"]),
      "",
    ].join("\n"));
    await this.dispatch([]);
  }

  async connect() {
    await this.dispatch(["connect"]);
  }

  async dispatch(args) {
    await this.commands.run(process.execPath, [path.join(this.root, "package", "dispatch.mjs"), ...args], { cwd: this.root });
  }

  async hasTailscale() {
    const candidates = (process.env.PATH || "").split(path.delimiter)
      .filter(Boolean).map(directory => path.join(directory, process.platform === "win32" ? "tailscale.exe" : "tailscale"));
    if (process.platform === "win32" && process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, "Tailscale", "tailscale.exe"));
    }
    for (const candidate of candidates) {
      try { await fs.access(candidate); return true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return false;
  }
}
