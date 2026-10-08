/*
 * Exports:
 * - resolveDataRoot: resolve the per-user directory without dependency imports.
 * - journalPath: locate the durable repair journal.
 * - readJournal: read and validate the journal, preserving missing-file semantics.
 * - writeJournal: atomically persist a valid repair journal.
 * - isRepairPending: only a completed repair permits loading dependencies.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function resolveDataRoot({ environment = process.env, homeDirectory = os.homedir(), platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = environment.WORKBENCH_DATA_ROOT?.trim();
  if (override) return paths.resolve(override);
  if (platform === "win32") return paths.resolve(
    environment.LOCALAPPDATA?.trim() || paths.join(homeDirectory, "AppData", "Local"), "inthedark", "wb",
  );
  if (platform === "darwin") return paths.resolve(homeDirectory, "Library", "Application Support", "inthedark", "wb");
  const xdg = environment.XDG_DATA_HOME?.trim();
  return paths.resolve(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(homeDirectory, ".local", "share"), "inthedark", "wb");
}

export function journalPath(dataRoot = resolveDataRoot()) {
  return path.join(dataRoot, "update", "journal.json");
}

// Keep this built-ins-only boundary aligned with InstallationRepairJournalSchema.
function validate(value) {
  const object = value && typeof value === "object" && !Array.isArray(value);
  const sha = value => value === null || typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
  const text = (value, max) => typeof value === "string" && value.length <= max;
  const timestamp = value => Number.isSafeInteger(value) && value >= 0;
  const keys = ["version", "id", "phase", "fromSha", "toSha", "logPath", "lastError", "createdAt", "updatedAt", "failure"];
  const failure = value?.failure;
  if (!object || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.version !== 1 || !text(value.id, 36) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id)
    || !["pending", "stopping", "installing", "rolling-back", "clean-installing", "done", "stranded"].includes(value.phase)
    || !sha(value.fromSha) || !sha(value.toSha) || !text(value.logPath, 4096)
    || !(value.lastError === null || text(value.lastError, 512)) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || !(failure === null || failure && typeof failure === "object" && !Array.isArray(failure)
      && Object.keys(failure).length === 3 && Object.keys(failure).every(key => ["at", "logPath", "message"].includes(key))
      && timestamp(failure.at) && text(failure.logPath, 4096) && text(failure.message, 512))) {
    throw new Error("Workbench update repair journal is invalid. Preserve it and inspect the update log before repairing.");
  }
  return value;
}

export async function readJournal(dataRoot = resolveDataRoot(), files = fs) {
  let text;
  try { text = await files.readFile(journalPath(dataRoot), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Workbench update repair journal contains invalid JSON: ${journalPath(dataRoot)}`, { cause: error }); }
  return validate(value);
}

export async function writeJournal(journal, dataRoot = resolveDataRoot(), files = fs) {
  validate(journal);
  const filename = journalPath(dataRoot);
  await files.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await files.writeFile(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600, flag: "wx" });
  await files.rename(temporary, filename);
}

export function isRepairPending(journal) {
  return journal !== null && journal.phase !== "done";
}
