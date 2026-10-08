/*
 * Exports:
 * - WorkbenchInstallPrompt (default): owns dependency-free installer terminal interaction and the pinned cube header.
 */
import path from "node:path";
import os from "node:os";
import { emitKeypressEvents } from "node:readline";
import { INSTALLER_CUBE_ROWS, installerCubeWidth, renderInstallerCube } from "./installer-cube.mjs";

const WORDMARK = "w o r k b e n c h";
const FRAME_INTERVAL_MS = 80;
// Install log rows kept below a pinned header; shorter terminals skip pinning.
const LOG_ROWS = 8;

function scheduleFrames(tick) {
  const timer = setInterval(tick, FRAME_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export default class WorkbenchInstallPrompt {
  constructor({
    input = process.stdin,
    output = process.stdout,
    platform = process.platform,
    cwd = process.cwd(),
    home = os.homedir(),
    schedule = scheduleFrames,
    now = () => performance.now(),
  } = {}) {
    this.input = input;
    this.output = output;
    this.schedule = schedule;
    this.now = now;
    this.paths = platform === "win32" ? path.win32 : path.posix;
    this.windows = platform === "win32";
    this.cwd = cwd;
    this.home = home;
    this.active = false;
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

  location(label, initialValue) {
    let characters = Array.from(initialValue);
    let cursor = characters.length;
    return this.interact(
      () => {
        const value = characters.join("");
        const suffix = this.suffix(value);
        // Keep a bounded one-line viewport so redraw never overwrites earlier setup output.
        const available = Math.max(8, (this.output.columns || 80) - label.length - suffix.length - 4);
        const start = Math.max(0, cursor - available + 1);
        const visible = characters.slice(start, start + available).join("");
        const prefix = `${label}: `;
        this.output.write(`\r\u001b[2K${prefix}${visible}\u001b[2m${suffix}\u001b[22m`);
        this.output.write(`\r\u001b[${prefix.length + characters.slice(start, cursor).join("").length + 1}G`);
      },
      (text, key, accept) => {
        if (key.name === "return") {
          accept(this.destination(characters.join("")));
          return;
        }
        if (key.name === "left") cursor = Math.max(0, cursor - 1);
        else if (key.name === "right") cursor = Math.min(characters.length, cursor + 1);
        else if (key.name === "home" || (key.ctrl && key.name === "a")) cursor = 0;
        else if (key.name === "end" || (key.ctrl && key.name === "e")) cursor = characters.length;
        else if (key.name === "backspace" && cursor > 0) characters.splice(--cursor, 1);
        else if (key.name === "delete") characters.splice(cursor, 1);
        else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(text)) {
          const added = Array.from(text);
          characters.splice(cursor, 0, ...added);
          cursor += added.length;
        }
      },
    );
  }

  choose(label, choices) {
    if (!choices.length) return Promise.reject(new Error("A setup choice needs options."));
    let selected = 0;
    let rendered = false;
    return this.interact(
      () => {
        if (rendered && choices.length > 1) this.output.write(`\r\u001b[${choices.length - 1}A`);
        this.output.write(choices.map((choice, index) =>
          `\r\u001b[2K${index === selected ? `> \u001b[7m${choice}\u001b[27m` : `  ${choice}`}`,
        ).join("\n"));
        rendered = true;
      },
      (_text, key, accept) => {
        if (key.name === "up") selected = (selected + choices.length - 1) % choices.length;
        else if (key.name === "down" || key.name === "tab") selected = (selected + 1) % choices.length;
        else if (key.name === "return") accept(choices[selected]);
      },
      label,
      choices.length,
    );
  }

  /** Cube height that fits above the wordmark, label and prompt without scrolling the screen; 0 for none. */
  cubeRows(label, promptLines) {
    const columns = this.output.columns || 80;
    const rows = this.output.rows || 24;
    const labelLines = label
      ? label.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0)
      : 0;
    // Wordmark, blank line, label, prompt. Scrolling would misplace every home-anchored redraw.
    let cube = Math.min(INSTALLER_CUBE_ROWS.max, rows - 2 - labelLines - promptLines);
    while (cube >= INSTALLER_CUBE_ROWS.min && installerCubeWidth(cube) > columns) cube--;
    return cube >= INSTALLER_CUBE_ROWS.min ? cube : 0;
  }

  /** Animated cube frames, an in-place redraw and the centred wordmark for a header of `cubeRows` (0 for wordmark only). */
  header(cubeRows) {
    const started = this.now();
    const frame = () => renderInstallerCube((this.now() - started) / 1000, cubeRows).join("\r\n");
    return {
      frame,
      // Save and restore the cursor around each frame so prompts and output below never move.
      draw: () => this.output.write(`\u001b7\u001b[H${frame()}\u001b8`),
      wordmark: cubeRows
        ? WORDMARK.padStart(Math.floor((installerCubeWidth(cubeRows) + WORDMARK.length) / 2))
        : WORDMARK,
    };
  }

  /** Runs `task` with the animated header pinned above a scroll region holding its output. */
  async withHeader(task) {
    const cubeRows = this.output.isTTY && !this.active ? this.cubeRows("", LOG_ROWS) : 0;
    if (!cubeRows) return await task();
    const rows = this.output.rows || 24;
    const top = cubeRows + 3;
    const { frame, draw, wordmark } = this.header(cubeRows);
    let pinned = true;
    // Resetting the region homes the cursor; save/restore keeps it where the output left off.
    const release = () => {
      if (!pinned) return;
      pinned = false;
      this.output.write("\u001b7\u001b[r\u001b8");
    };
    // Default SIGINT exits without cleanup and would trap the shell inside the region.
    const interrupt = () => {
      release();
      process.exit(130);
    };
    process.once("exit", release);
    process.once("SIGINT", interrupt);
    let stopAnimation = () => {};
    try {
      // Blank lines push earlier shell output into scrollback instead of erasing it.
      this.output.write(`${"\r\n".repeat(rows)}\u001b[H${frame()}\r\n${wordmark}\r\n\u001b[${top};${rows}r\u001b[${top};1H`);
      stopAnimation = this.schedule(() => { if (pinned) draw(); });
      return await task();
    } finally {
      stopAnimation();
      process.removeListener("exit", release);
      process.removeListener("SIGINT", interrupt);
      release();
    }
  }

  interact(render, handle, label = "", promptLines = 1) {
    if (!this.input.isTTY || !this.output.isTTY) {
      return Promise.reject(new Error("Workbench setup needs an interactive terminal; no changes were accepted."));
    }
    if (this.active) return Promise.reject(new Error("Another setup prompt is active."));
    this.active = true;
    const wasRaw = this.input.isRaw;
    // A fresh stdin is neither flowing nor paused; leaving it flowing would let this
    // process keep reading the console and steal keys from later child prompts.
    const wasFlowing = this.input.readableFlowing === true;
    emitKeypressEvents(this.input);
    return new Promise((resolve, reject) => {
      let settled = false;
      let screenActive = false;
      let stopAnimation = null;
      const restoreScreen = () => {
        if (!screenActive) return;
        screenActive = false;
        this.output.write("\u001b[0m\u001b[?1049l");
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        stopAnimation?.();
        stopAnimation = null;
        this.input.removeListener("keypress", onKey);
        this.input.removeListener("end", onEnd);
        this.input.removeListener("error", onError);
        process.removeListener("exit", restoreScreen);
        try {
          this.input.setRawMode(Boolean(wasRaw));
          if (!wasFlowing) this.input.pause();
        } catch (cleanupError) {
          error ??= cleanupError;
        }
        try { restoreScreen(); }
        catch (cleanupError) { error ??= cleanupError; }
        this.active = false;
        if (error) reject(error);
        else resolve(value);
      };
      const onEnd = () => finish(new DOMException("Setup cancelled.", "AbortError"));
      const onError = (error) => finish(error);
      const onKey = (text, key = {}) => {
        if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") {
          onEnd();
          return;
        }
        try {
          handle(text, key, (value) => finish(null, value));
          if (!settled) render();
        } catch (error) {
          finish(error);
        }
      };
      this.input.on("keypress", onKey);
      this.input.once("end", onEnd);
      this.input.once("error", onError);
      try {
        this.input.setRawMode(true);
        this.input.resume();
        screenActive = true;
        process.once("exit", restoreScreen);
        const cubeRows = this.cubeRows(label, promptLines);
        const { frame, draw, wordmark } = this.header(cubeRows);
        this.output.write(`\u001b[?1049h\u001b[2J\u001b[H${cubeRows ? `${frame()}\r\n` : ""}${wordmark}\r\n\r\n${label ? `${label}\r\n` : ""}`);
        render();
        if (cubeRows) {
          stopAnimation = this.schedule(() => {
            if (settled) return;
            try { draw(); }
            catch (error) { finish(error); }
          });
        }
      } catch (error) {
        finish(error);
      }
    });
  }
}
