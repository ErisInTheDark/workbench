/*
 * Exports:
 * - WorkbenchInstaller (default): owns pinned checkout preparation and first-run actions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchInstallPrompt from "../package/WorkbenchInstallPrompt.mjs";
import WorkbenchBootstrapCommand from "../package/WorkbenchBootstrapCommand.mjs";
import WorkbenchToolchain from "../package/WorkbenchToolchain.mjs";

export default class WorkbenchInstaller {
  constructor({
    root,
    commands = new WorkbenchBootstrapCommand(),
    toolchain = new WorkbenchToolchain({ commands }),
    prompt = new WorkbenchInstallPrompt(),
    detectTailscale,
    nodeVersion = process.versions.node,
    write = text => process.stdout.write(text),
  }) {
    this.root = root;
    this.commands = commands;
    this.toolchain = toolchain;
    this.prompt = prompt;
    this.detectTailscale = detectTailscale ?? (() => this.hasTailscale());
    this.nodeVersion = nodeVersion;
    this.write = write;
  }

  async prepare() {
    this.write("Installing pinned runtime...\n");
    await this.toolchain.ensure();
    await this.toolchain.run(["env", "install"], { cwd: this.root });
    await this.toolchain.runNode(this.root, path.join(this.root, "installation", "install.mjs"), ["--prepare-pinned"], {
      cwd: this.root,
    });
  }

  async preparePinned() {
    const manifest = JSON.parse(await fs.readFile(path.join(this.root, "package.json"), "utf8"));
    const expectedNode = manifest.devEngines?.runtime?.version;
    if (!expectedNode || this.nodeVersion !== expectedNode) {
      throw new Error(`Workbench checkout requires Node ${expectedNode || "from devEngines.runtime"}; received ${this.nodeVersion}. Vite+ must use the project's pinned runtime.`);
    }
    this.write("Building dependencies...\n");
    let installOutput = "";
    let missingPython = false;
    try {
      await this.toolchain.run(["install"], {
        cwd: this.root,
        onOutput: text => {
          installOutput = `${installOutput}${text}`.slice(-4096);
          missingPython ||= /Could not find any Python installation|Python is not set from environment variable PYTHON/u.test(installOutput);
        },
      });
    } catch (error) {
      if (missingPython) {
        throw new Error("Dependency build needs Python on PATH. Install the required native build tools for this system, then retry the fresh install.", { cause: error });
      }
      throw error;
    }
    this.write("Building frontend...\n");
    await this.toolchain.run(["run", "build:app"], { cwd: this.root });
    this.write("Checkout preparation complete.\n");
  }

  async welcome() {
    let wake = "Skip";
    if (await this.detectTailscale()) {
      wake = await this.prompt.choose(
        "Workbench has an APP and a DAEMON background service. Running the app will automatically launch the daemon. If you're on a shared network with Tailscale, your app can connect to other daemons when their apps are not running. This requires a thin wake service to run on the device, allowing other apps to find it.\n\nDo you want to connect to this daemon from the workbench app on other devices?",
        ["Enable wake service", "Skip"],
      );
    }
    const shortcut = await this.prompt.choose("Add a desktop shortcut?", ["Add shortcut", "Skip"]);
    if (shortcut === "Add shortcut") await this.dispatch(["shortcut"]);
    if (wake === "Enable wake service") await this.connect();
    this.write([
      "Workbench CLI:",
      "  wb - launch",
      "  wb connect - enable wake service",
      "  wb disconnect - disable wake service",
      "  wb repair - reinstall dependencies and recover a failed update",
      ...(shortcut === "Add shortcut" ? [] : ["  wb shortcut - add a desktop shortcut"]),
      "",
    ].join("\n"));
    await this.dispatch([]);
  }

  async connect() {
    await this.dispatch(["connect"]);
  }

  async dispatch(args) {
    await this.toolchain.runNode(this.root, path.join(this.root, "cli", "dispatch.mjs"), args, { cwd: this.root });
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
