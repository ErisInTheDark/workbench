/*
 * Exports:
 * - config: load dotenv files, resolve named store references, and enforce an optional missing-variable policy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import StoreCommandRunner from "./StoreCommandRunner.mjs";
import {
  DEFAULT_STORE_DEFINITIONS,
  expandStoreCommand,
  findStoreReferences,
  parseStoreDefinitions,
} from "./store-definitions.mjs";

function warnDefault(message) {
  process.emitWarning(message, "WorkbenchStoreWarning");
}

function stripTerminalLineEnding(value) {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

async function readParsed(paths, encoding, override) {
  const parsed = {};
  let error;
  for (const file of paths) {
    try {
      const values = dotenv.parse(await fs.readFile(path.resolve(file), { encoding }));
      for (const [name, value] of Object.entries(values)) {
        if (override || !Object.hasOwn(parsed, name)) parsed[name] = value;
      }
    } catch (failure) {
      error ??= failure;
    }
  }
  return { parsed, error };
}

async function resolveReferences(parsed, definitions, { runner, signal, warn, policy }) {
  const references = new Map(Object.entries(parsed).map(([name, value]) => [name, findStoreReferences(value)]));
  const unresolved = new Set();
  let stores;
  try {
    stores = parseStoreDefinitions(definitions);
  } catch (failure) {
    warn(policy ? failure.message : `${failure.message} Store references were left unchanged.`);
    for (const [name, found] of references) if (found.length) unresolved.add(name);
    return { parsed, unresolved };
  }
  const lookups = new Map();
  for (const [name, found] of references) {
    for (const { key, store } of found) {
      const id = JSON.stringify([store, key]);
      if (stores.has(store) && !lookups.has(id)) lookups.set(id, { argv: expandStoreCommand(stores.get(store), key), owner: name, store });
    }
  }
  const results = new Map(await Promise.all(Array.from(lookups, async ([id, lookup]) => {
    const result = await runner.run(lookup.argv, { signal });
    if (!result.ok) {
      const detail = result.reason === "exit" ? `exited with ${result.exitCode}` : `failed (${result.reason})`;
      warn(`The ${lookup.store} store lookup for ${lookup.owner} ${detail}.${policy ? "" : " The reference was left unchanged."}`);
    }
    return [id, result];
  })));
  const resolved = Object.fromEntries(Object.entries(parsed).map(([name, value]) => {
    let next = "";
    let cursor = 0;
    for (const reference of references.get(name)) {
      const result = results.get(JSON.stringify([reference.store, reference.key]));
      if (!result?.ok) unresolved.add(name);
      next += value.slice(cursor, reference.start) + (result?.ok ? stripTerminalLineEnding(result.stdout) : reference.text);
      cursor = reference.end;
    }
    return [name, next + value.slice(cursor)];
  }));
  return { parsed: resolved, unresolved };
}

function missingPolicy(required, optional) {
  if (required !== undefined && optional !== undefined) {
    throw new TypeError("Specify either required or optional, not both.");
  }
  const names = required ?? optional;
  if (required === undefined && optional === undefined) return null;
  if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !name.length)) {
    throw new TypeError("required and optional must be arrays of nonempty environment variable names.");
  }
  return { names: new Set(names), listedRequired: required !== undefined };
}

function applyMissingPolicy(parsed, unresolved, policy, processEnv, override) {
  if (!policy) return;
  const missing = [];
  for (const name of new Set([...Object.keys(parsed), ...policy.names])) {
    const existing = Object.hasOwn(processEnv, name) && processEnv[name] !== undefined;
    const fromFile = Object.hasOwn(parsed, name);
    if (existing && (!override || !fromFile)) continue;
    if (fromFile && !unresolved.has(name)) continue;
    if (policy.names.has(name) === policy.listedRequired) missing.push(name);
    else Object.defineProperty(parsed, name, { value: "", writable: true, enumerable: true, configurable: true });
  }
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

export async function config({
  path: paths = ".env",
  encoding = "utf8",
  override = false,
  processEnv = process.env,
  signal,
  warn = warnDefault,
  runner = new StoreCommandRunner(),
  required,
  optional,
} = {}) {
  signal?.throwIfAborted();
  const policy = missingPolicy(required, optional);
  const { parsed: raw, error } = await readParsed(Array.isArray(paths) ? paths : [paths], encoding, override);
  const definitions = raw.WB_STORES?.trim() || processEnv.WB_STORES?.trim() || DEFAULT_STORE_DEFINITIONS;
  const { parsed, unresolved } = await resolveReferences(raw, definitions, { runner, signal, warn, policy });
  applyMissingPolicy(parsed, unresolved, policy, processEnv, override);
  const values = policy && !override
    ? Object.fromEntries(Object.entries(parsed).filter(([name]) => !Object.hasOwn(processEnv, name) || processEnv[name] === undefined))
    : parsed;
  dotenv.populate(processEnv, values, { override: policy ? true : override });
  return error ? { parsed, error } : { parsed };
}
