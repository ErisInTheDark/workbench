/*
 * Exports:
 * - WorkbenchBootstrapCommand (default): owns bootstrap child commands, Windows executable lookup (including Git Bash), and failures.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export default class WorkbenchBootstrapCommand {
  constructor({ output = process.stdout, errorOutput = process.stderr, environment = process.env } = {}) {
    this.output = output;
    this.errorOutput = errorOutput;
    this.environment = environment;
  }

  /** Environment variable by name; Windows names are case-insensitive, but copied env objects are not. */
  variable(name) {
    if (process.platform !== "win32") return this.environment[name];
    const key = Object.keys(this.environment).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : this.environment[key];
  }

  async resolve(command) {
    if (process.platform === "win32" && command === "bash") return [await this.resolveBash()];
    if (process.platform !== "win32" || !["npm", "pnpm"].includes(command)) return [command];
    const directories = [path.dirname(process.execPath), ...(this.variable("PATH") || "").split(path.delimiter)];
    for (const directory of directories) {
      if (!directory) continue;
      const executable = path.join(directory, `${command}.exe`);
      try {
        await fs.access(executable);
        return [executable];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // npm/pnpm's Windows cmd wrappers cannot safely forward arbitrary paths.
      // Invoke their installed Node entry instead of adding a command-shell layer.
      const entry = command === "npm" ? "npm/bin/npm-cli.js" : "pnpm/bin/pnpm.cjs";
      const script = path.join(directory, "node_modules", entry);
      try {
        await fs.access(script);
        return [process.execPath, script];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Cannot locate ${command}'s executable or Node entry. Install ${command} and ensure it is on PATH.`);
  }

  /**
   * Windows bash that can run Workbench. Git for Windows usually puts only git on PATH, and the
   * bash.exe Windows does find is often WSL's launcher, which runs scripts inside Linux.
   */
  async resolveBash() {
    const exists = async file => {
      try { await fs.access(file); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    };
    const directories = (this.variable("PATH") || "").split(path.delimiter).filter(Boolean);
    const local = this.variable("LOCALAPPDATA");
    const launchers = [
      path.join(this.variable("SystemRoot") || "C:\\Windows", "System32"),
      ...(local ? [path.join(local, "Microsoft", "WindowsApps")] : []),
    ].map(directory => path.resolve(directory).toLowerCase());
    let sawLauncher = false;
    for (const directory of directories) {
      const bash = path.join(directory, "bash.exe");
      if (!await exists(bash)) continue;
      if (launchers.includes(path.resolve(directory).toLowerCase())) sawLauncher = true;
      else return bash;
    }
    // git.exe lives in Git\cmd, Git\bin or Git\mingw64\bin; Git Bash is always Git\bin\bash.exe.
    for (const directory of directories) {
      if (!await exists(path.join(directory, "git.exe"))) continue;
      const parent = path.dirname(directory);
      const root = path.basename(parent).toLowerCase() === "mingw64" ? path.dirname(parent) : parent;
      const bash = path.join(root, "bin", "bash.exe");
      if (await exists(bash)) return bash;
    }
    for (const base of [this.variable("ProgramFiles"), local && path.join(local, "Programs")]) {
      if (!base) continue;
      const bash = path.join(base, "Git", "bin", "bash.exe");
      if (await exists(bash)) return bash;
    }
    throw new Error(`Workbench needs Git Bash on Windows.${sawLauncher ? " The bash on PATH is WSL's, which cannot run Workbench." : ""} Install Git for Windows, then retry.`);
  }

  async run(command, args, { cwd, signal, onOutput, environment = {}, output = this.output, errorOutput = this.errorOutput, interactive = false } = {}) {
    signal?.throwIfAborted();
    const [executable, ...prefix] = await this.resolve(command);
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, [...prefix, ...args], {
        cwd,
        env: { ...this.environment, ...environment },
        windowsHide: true,
        stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
        signal,
      });
      let failure;
      const relay = signal => { child.kill(signal); };
      const interrupt = () => relay("SIGINT");
      const terminate = () => relay("SIGTERM");
      const hangup = () => relay("SIGHUP");
      if (interactive) {
        process.on("SIGINT", interrupt);
        process.on("SIGTERM", terminate);
        process.on("SIGHUP", hangup);
      }
      child.on("error", error => { failure = error; });
      const forward = (stream, output) => {
        stream.on("data", bytes => {
          output.write(bytes);
          if (onOutput) {
            try { onOutput(bytes.toString()); }
            catch (error) { failure = error; child.kill(); }
          }
        });
      };
      if (!interactive) {
        forward(child.stdout, output);
        forward(child.stderr, errorOutput);
      }
      child.once("close", (code, exitSignal) => {
        if (interactive) {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", terminate);
          process.off("SIGHUP", hangup);
        }
        if (failure?.code === "ENOENT") {
          reject(Object.assign(new Error(`Cannot start ${command}: executable not found. Install it and make it available on PATH, then retry.`, { cause: failure }), {
            code: "ENOENT",
          }));
        } else if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(Object.assign(new Error(`${command} failed with ${exitSignal ? `signal ${exitSignal}` : `status ${code ?? "unknown"}`}.`), { exitCode: code ?? 1 }));
      });
    });
  }
}
