/*
 * Exports:
 * - readOpenCodeApiKey: read the OpenCode Zen API key from OpenCode's own credential store, or null when it has none.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Mirrors OpenCode's `Global.Path.data` (xdg-basedir on every platform) and its `OPENCODE_AUTH_CONTENT` override.
function authFilePath(environment: NodeJS.ProcessEnv) {
  const dataHome = environment.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

const AuthFileSchema = z.record(z.string(), z.unknown());
const ApiAuthSchema = z.object({ type: z.literal("api"), key: z.string().min(1) }).passthrough();

export async function readOpenCodeApiKey(environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let raw = environment.OPENCODE_AUTH_CONTENT;
  if (!raw) {
    try {
      raw = await fs.readFile(authFilePath(environment), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const parsed = AuthFileSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) throw new Error("OpenCode's credential file is not a JSON object.");
  const entry = ApiAuthSchema.safeParse(parsed.data.opencode);
  return entry.success ? entry.data.key : null;
}
