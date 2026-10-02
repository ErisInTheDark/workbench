/*
 * Exports:
 * - config: load dotenv files, then replace resolvable `${store:key}` references through named WB_STORES commands.
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

function isManagedAgentProcess() {
  return Boolean(process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim());
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

async function resolveReferences(parsed, definitions, { runner, signal, warn }) {
  let stores;
  try {
    stores = parseStoreDefinitions(definitions);
  } catch (failure) {
    warn(`${failure.message} Store references were left unchanged.`);
    return parsed;
  }
  const references = new Map(Object.entries(parsed).map(([name, value]) => [name, findStoreReferences(value)]));
  const lookups = new Map();
  for (const [name, found] of references) {
    for (const { key, store } of found) {
      const id = JSON.stringify([store, key]);
      if (stores.has(store) && !lookups.has(id)) lookups.set(id, { argv: expandStoreCommand(stores.get(store), key), owner: name, store });
    }
  }
  if (!lookups.size) return parsed;
  if (isManagedAgentProcess()) {
    warn("Store lookups are disabled in Workbench-managed agent processes. Store references were left unchanged.");
    return parsed;
  }
  const results = new Map(await Promise.all(Array.from(lookups, async ([id, lookup]) => {
    const result = await runner.run(lookup.argv, { signal });
    if (!result.ok) {
      const detail = result.reason === "exit" ? `exited with ${result.exitCode}` : `failed (${result.reason})`;
      warn(`The ${lookup.store} store lookup for ${lookup.owner} ${detail}. The reference was left unchanged.`);
    }
    return [id, result];
  })));
  return Object.fromEntries(Object.entries(parsed).map(([name, value]) => {
    let next = "";
    let cursor = 0;
    for (const reference of references.get(name)) {
      const result = results.get(JSON.stringify([reference.store, reference.key]));
      next += value.slice(cursor, reference.start) + (result?.ok ? stripTerminalLineEnding(result.stdout) : reference.text);
      cursor = reference.end;
    }
    return [name, next + value.slice(cursor)];
  }));
}

export async function config({
  path: paths = ".env",
  encoding = "utf8",
  override = false,
  processEnv = process.env,
  signal,
  warn = warnDefault,
  runner = new StoreCommandRunner(),
} = {}) {
  signal?.throwIfAborted();
  const { parsed: raw, error } = await readParsed(Array.isArray(paths) ? paths : [paths], encoding, override);
  const definitions = raw.WB_STORES?.trim() || processEnv.WB_STORES?.trim() || DEFAULT_STORE_DEFINITIONS;
  const parsed = await resolveReferences(raw, definitions, { runner, signal, warn });
  dotenv.populate(processEnv, parsed, { override });
  return error ? { parsed, error } : { parsed };
}
