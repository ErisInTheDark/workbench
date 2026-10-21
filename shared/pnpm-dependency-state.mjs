/*
 * Exports:
 * - APP_DEPENDENCY_IMPORTERS/DAEMON_DEPENDENCY_IMPORTERS: workspace importers each process shell loads.
 * - lockfileClosure: snapshot keys reachable from importers in pnpm lockfile text.
 * - readDependencyFingerprint: hash the wanted or installed closure of importers.
 * - hasDependencyDrift: whether installed dependencies differ from the lockfile.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const APP_DEPENDENCY_IMPORTERS = Object.freeze([".", "app", "shared"]);
// The host runs from daemon/, so it shares the daemon importer.
export const DAEMON_DEPENDENCY_IMPORTERS = Object.freeze([".", "daemon", "shared"]);

const LOCKFILES = { wanted: "pnpm-lock.yaml", installed: path.join("node_modules", ".pnpm", "lock.yaml") };
const IMPORTER_GROUPS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);
const SNAPSHOT_GROUPS = new Set(["dependencies", "optionalDependencies"]);

function unquote(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1);
  return value;
}

/** One `key:` or `key: value` line of pnpm's block YAML; quoted keys may contain `: `. */
function entry(line) {
  const text = line.trim();
  let end;
  if (text.startsWith("'") || text.startsWith("\"")) {
    const quote = text[0];
    end = 1;
    while (end < text.length) {
      if (text[end] === quote && !(quote === "'" && text[end + 1] === "'")) break;
      end += quote === "'" && text[end] === "'" ? 2 : 1;
    }
    end += 1;
  } else {
    const separator = text.indexOf(": ");
    end = separator < 0 ? text.endsWith(":") ? text.length - 1 : -1 : separator;
  }
  if (end < 0 || (text[end] !== ":" && end !== text.length)) return null;
  const rest = text.slice(end + 1).trim();
  return { key: unquote(text.slice(0, end)), value: rest ? unquote(rest) : null };
}

/** pnpm 9 lockfiles may prefix vp's environment document; the workspace graph is the last document. */
function parse(text) {
  const documents = text.split(/^---\s*$/mu);
  const lines = documents[documents.length - 1].split(/\r?\n/u);
  const importers = new Map();
  const snapshots = new Map();
  let section = null;
  let owner = null;
  let group = null;
  let dependency = null;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const parsed = entry(line);
    if (!parsed) continue;
    if (indent === 0) { section = parsed.key; owner = group = dependency = null; continue; }
    if (section === "importers") {
      if (indent === 2) { owner = new Map(); importers.set(parsed.key, owner); group = dependency = null; }
      else if (indent === 4) { group = IMPORTER_GROUPS.has(parsed.key) ? parsed.key : null; dependency = null; }
      else if (indent === 6 && group && owner) dependency = parsed.key;
      else if (indent === 8 && group && owner && dependency && parsed.key === "version" && parsed.value) {
        owner.set(dependency, parsed.value);
      }
    } else if (section === "snapshots") {
      if (indent === 2) { owner = new Map(); snapshots.set(parsed.key, owner); group = null; }
      else if (indent === 4) group = SNAPSHOT_GROUPS.has(parsed.key) ? parsed.key : null;
      else if (indent === 6 && group && owner && parsed.value) owner.set(parsed.key, parsed.value);
    }
  }
  return { importers, snapshots };
}

/** `link:` siblings and vp's `runtime:` node are not installed packages. */
function snapshotKey(name, version) {
  if (version.startsWith("link:") || version.startsWith("runtime:")) return null;
  // Aliases (`npm:` specifiers) record the target package as `name@version`.
  return version.split("(")[0].slice(1).includes("@") ? version : `${name}@${version}`;
}

export function lockfileClosure(text, importers) {
  const graph = parse(text);
  const closure = new Set();
  const pending = [];
  const visit = dependencies => {
    for (const [name, version] of dependencies ?? []) {
      const key = snapshotKey(name, version);
      if (key && !closure.has(key)) { closure.add(key); pending.push(key); }
    }
  };
  for (const importer of importers ?? graph.importers.keys()) visit(graph.importers.get(importer));
  while (pending.length) visit(graph.snapshots.get(pending.pop()));
  return [...closure].sort();
}

async function readLockfile(root, which) {
  try { return await fs.readFile(path.join(root, LOCKFILES[which]), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function fingerprint(text, importers) {
  return createHash("sha256").update(lockfileClosure(text, importers).join("\n")).digest("hex");
}

export async function readDependencyFingerprint(root, which, importers) {
  const text = await readLockfile(root, which);
  return text === null ? null : fingerprint(text, importers);
}

export async function hasDependencyDrift(root, importers) {
  const [wanted, installed] = await Promise.all([readLockfile(root, "wanted"), readLockfile(root, "installed")]);
  if (wanted === null) return false;
  if (installed === null) return true;
  const names = importers ?? [...parse(wanted).importers.keys()];
  return fingerprint(wanted, names) !== fingerprint(installed, names);
}
