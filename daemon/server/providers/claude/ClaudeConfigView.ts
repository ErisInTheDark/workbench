/*
 * Exports:
 * - ClaudeConfigViewSource: the daemon environment and home directory a view mirrors.
 * - default ClaudeConfigView: own one per-process Claude config root that links the user's real data,
 *   hides the account email from Claude's prompt context, and keeps credentials in the real store;
 *   `dataRoot` names that real data root.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ClaudeConfigViewSource {
  env: NodeJS.ProcessEnv;
  home: string;
}

// Credentials stay in the real store through CLAUDE_SECURESTORAGE_CONFIG_DIR; global configs are sanitized.
const UNCOPIED_FILES = new Set([".credentials.json", ".claude.json", ".config.json"]);

function warn(message: string, error: unknown) {
  console.warn(`[claude] ${message}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
}

async function exists(target: string) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Remove view-owned content without ever following a link into the user's real Claude data. */
async function removeOwned(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) {
    try {
      await fs.unlink(target);
    } catch (error) {
      // Some platforms only remove directory links through rmdir; it removes the link, never its target.
      if (!["EPERM", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await fs.rmdir(target);
    }
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) await removeOwned(path.join(target, entry));
    await fs.rmdir(target);
    return;
  }
  await fs.unlink(target);
}

function sanitizeGlobalConfig(text: string, now: number) {
  const config: unknown = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Claude global config is not a JSON object.");
  }
  const account = (config as Record<string, unknown>).oauthAccount;
  if (account && typeof account === "object" && !Array.isArray(account)) {
    const sanitized = { ...account as Record<string, unknown> };
    delete sanitized.emailAddress;
    // A fresh fetch time stops Claude refetching the profile, which would restore the email.
    sanitized.profileFetchedAt = now;
    (config as Record<string, unknown>).oauthAccount = sanitized;
  }
  return JSON.stringify(config, null, 2);
}

export default class ClaudeConfigView {
  private constructor(
    private readonly root: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}

  /** The user's real Claude data root, where native session history lives. */
  static dataRoot(source: ClaudeConfigViewSource = { env: process.env, home: os.homedir() }) {
    return source.env.CLAUDE_CONFIG_DIR || path.join(source.home, ".claude");
  }

  static async create(
    viewsRoot: string,
    source: ClaudeConfigViewSource = { env: process.env, home: os.homedir() },
    now = Date.now(),
  ) {
    const configured = source.env.CLAUDE_CONFIG_DIR || null;
    const realRoot = ClaudeConfigView.dataRoot(source);
    // Native session history must land in the real root even on a fresh installation.
    await fs.mkdir(path.join(realRoot, "projects"), { recursive: true });
    const root = path.join(viewsRoot, `${process.pid}-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    const view = new ClaudeConfigView(root, {
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: source.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined
        ? source.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
        // Empty selects the default store without the per-directory keychain suffix.
        : configured ?? "",
    });
    try {
      for (const entry of await fs.readdir(realRoot, { withFileTypes: true })) {
        const from = path.join(realRoot, entry.name);
        const to = path.join(root, entry.name);
        if (entry.isDirectory()) await fs.symlink(from, to, "junction");
        else if (entry.isFile() && !UNCOPIED_FILES.has(entry.name) && !entry.name.endsWith(".lock")) {
          await fs.copyFile(from, to);
        }
      }
      const legacy = path.join(realRoot, ".config.json");
      const global = await exists(legacy) ? legacy : path.join(configured ?? source.home, ".claude.json");
      if (await exists(global)) {
        await fs.writeFile(path.join(root, path.basename(global)),
          sanitizeGlobalConfig(await fs.readFile(global, "utf8"), now));
      }
      return view;
    } catch (error) {
      await view.dispose();
      throw error;
    }
  }

  /** Remove views left by earlier daemon processes; views of this process belong to live owners. */
  static async sweep(viewsRoot: string, pid = process.pid) {
    let entries: string[];
    try {
      entries = await fs.readdir(viewsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.split("-", 1)[0] === String(pid)) continue;
      try {
        await removeOwned(path.join(viewsRoot, entry));
      } catch (error) {
        warn("stale config view removal failed", error);
      }
    }
  }

  async dispose() {
    try {
      if (await exists(this.root)) await removeOwned(this.root);
    } catch (error) {
      warn("config view removal failed", error);
    }
  }
}
