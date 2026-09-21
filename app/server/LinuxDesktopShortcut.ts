/*
 * Exports:
 * - default LinuxDesktopShortcut: install owned freedesktop menu and desktop launch entries.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";

export default class LinuxDesktopShortcut {
  constructor(private readonly options: {
    root: string;
    launcher: string;
    home?: string;
    dataHome?: string;
    desktopDirectory?: () => Promise<string>;
  }) {}

  async install() {
    const home = this.options.home ?? homedir();
    const applications = path.join(this.options.dataHome ?? process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "applications");
    const desktop = await (this.options.desktopDirectory?.() ?? this.readDesktopDirectory(home));
    const contents = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Workbench",
      "Comment=Workbench owned desktop launcher",
      `Exec=${this.quote(this.options.launcher)} --workbench-root ${this.quote(this.options.root)}`,
      "Terminal=false",
      "Categories=Development;",
      "StartupNotify=false",
      "",
    ].join("\n");
    for (const directory of new Set([applications, desktop].filter(Boolean))) {
      await mkdir(directory, { recursive: true });
      const destination = path.join(directory, "inthedark-workbench.desktop");
      try {
        const previous = await readFile(destination, "utf8");
        if (!previous.includes("Comment=Workbench owned desktop launcher\n")) {
          throw new Error(`Refusing to replace an unrelated desktop entry: ${destination}`);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { mode: 0o755 });
      await rename(temporary, destination);
      await chmod(destination, 0o755);
    }
  }

  private quote(value: string) {
    if (/[\r\n\0]/u.test(value)) throw new Error("Desktop launcher paths cannot contain control characters.");
    // Exec quoting is separate from desktop-file string escaping.
    const exec = value.replace(/%/gu, "%%").replace(/[\\"`$]/gu, "\\$&");
    return `"${exec.replace(/\\/gu, "\\\\")}"`;
  }

  private readDesktopDirectory(home: string) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("xdg-user-dir", ["DESKTOP"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let failure = "";
      child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(0, 8192); });
      child.stderr.on("data", chunk => { failure = (failure + String(chunk)).slice(0, 512); });
      child.once("error", reject);
      child.once("close", code => {
        const directory = output.trim();
        if (code !== 0 || !path.isAbsolute(directory)) reject(new Error(`Cannot locate the desktop directory. ${failure}`));
        // XDG uses the home directory to indicate a disabled desktop.
        else resolve(path.resolve(directory) === path.resolve(home) ? "" : directory);
      });
    });
  }
}
