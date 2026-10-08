/*
 * Exports:
 * - WorkbenchBootstrapPrompt (default): owns the stable dependency-free consent and destination prompts used before cloning.
 */
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

export default class WorkbenchBootstrapPrompt {
  constructor({
    input = process.stdin,
    output = process.stdout,
    platform = process.platform,
    cwd = process.cwd(),
    home = os.homedir(),
    ask,
  } = {}) {
    this.input = input;
    this.output = output;
    this.paths = platform === "win32" ? path.win32 : path.posix;
    this.windows = platform === "win32";
    this.cwd = cwd;
    this.home = home;
    this.ask = ask ?? (question => this.question(question));
  }

  suffix(value) {
    const name = this.paths.basename(value);
    const comparable = this.windows ? name.toLowerCase() : name;
    if (comparable === "wb" || comparable === "workbench") return "";
    return `${value.endsWith(this.paths.sep) || (this.windows && value.endsWith("/")) ? "" : this.paths.sep}wb`;
  }

  destination(value) {
    if (!value.trim()) throw new Error("Choose an installation directory.");
    if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Installation paths cannot contain control characters.");
    const expanded = value === "~" ? this.home
      : value.startsWith("~/") || (this.windows && value.startsWith("~\\"))
        ? this.paths.join(this.home, value.slice(2)) : value;
    return this.paths.resolve(this.cwd, `${expanded}${this.suffix(expanded)}`);
  }

  async choose(label, choices) {
    if (!choices.length) throw new Error("A setup choice needs options.");
    const options = choices.map((choice, index) => `${index + 1}) ${choice}`).join("  ");
    while (true) {
      const answer = (await this.ask(`${label}\n${options}\nChoose [1]: `)).trim();
      const selected = answer === "" ? 0 : Number(answer) - 1;
      if (Number.isInteger(selected) && selected >= 0 && selected < choices.length) return choices[selected];
      this.output.write(`Choose a number from 1 to ${choices.length}.\n`);
    }
  }

  async location(label, initialValue) {
    const answer = await this.ask(`${label} [${initialValue}]: `);
    return this.destination(answer.trim() || initialValue);
  }

  withHeader(task) {
    return task();
  }

  async question(text) {
    if (!this.input.isTTY || !this.output.isTTY) {
      throw new Error("Workbench setup needs an interactive terminal; no changes were accepted.");
    }
    const terminal = createInterface({ input: this.input, output: this.output });
    try { return await terminal.question(text); }
    finally { terminal.close(); }
  }
}
