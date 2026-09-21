/*
 * Exports:
 * - SetupCommand (default): owns checkout setup child commands and their failures.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export default class SetupCommand {
  constructor({ output = process.stdout, errorOutput = process.stderr, environment = process.env } = {}) {
    this.output = output;
    this.errorOutput = errorOutput;
    this.environment = environment;
  }

  async resolve(command) {
    if (process.platform !== "win32" || !["npm", "pnpm"].includes(command)) return [command];
    const directories = [path.dirname(process.execPath), ...(this.environment.PATH || "").split(path.delimiter)];
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

  async run(command, args, { cwd, signal, onOutput, environment = {}, output = this.output, errorOutput = this.errorOutput } = {}) {
    signal?.throwIfAborted();
    const [executable, ...prefix] = await this.resolve(command);
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, [...prefix, ...args], {
        cwd,
        env: { ...this.environment, ...environment },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let failure;
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
      forward(child.stdout, output);
      forward(child.stderr, errorOutput);
      child.once("close", (code, exitSignal) => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(Object.assign(new Error(`${command} failed with ${exitSignal ? `signal ${exitSignal}` : `status ${code ?? "unknown"}`}.`), { exitCode: code ?? 1 }));
      });
    });
  }
}
