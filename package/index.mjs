/*
 * Exports:
 * - config: load and map dotenv values, resolve store references (optionally waiting out unavailable stores), and enforce an optional missing-variable policy.
 * - WorkbenchConfigError: re-exported rejection for missing required names, carrying store lookup failures and retryability.
 * - arcTree: load the worktree as the calling agent thread builds it, or the plain filesystem without one.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import dotenv from "dotenv";
import StoreCommandRunner from "./StoreCommandRunner.mjs";
import WorkbenchArcTree from "./WorkbenchArcTree.mjs";
import WorkbenchConfigError, { STORE_UNAVAILABLE_EXIT_CODE, lookupFailureDetail } from "./WorkbenchConfigError.mjs";
import {
  DEFAULT_STORE_DEFINITIONS,
  expandStoreCommand,
  findStoreReferences,
  parseStoreDefinitions,
} from "./store-definitions.mjs";

export { WorkbenchConfigError };

const STORE_RETRY_INTERVAL_MS = 1000;

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

async function sleep(milliseconds, signal) {
  try {
    await setTimeout(milliseconds, undefined, { signal });
  } catch (failure) {
    signal?.throwIfAborted();
    throw failure;
  }
}

function isUnavailable(result) {
  return !result.ok && result.exitCode === STORE_UNAVAILABLE_EXIT_CODE;
}

/** Retries only lookups whose store reported temporary unavailability, until the wait budget runs out. */
async function runLookups(lookups, { runner, signal, warn, storeWaitMs, delay }) {
  const results = new Map();
  let pending = Array.from(lookups);
  let retries = Math.ceil(storeWaitMs / STORE_RETRY_INTERVAL_MS);
  for (let attempt = 0; ; attempt += 1) {
    const settled = await Promise.all(pending.map(async ([id, lookup]) => [id, await runner.run(lookup.argv, { signal })]));
    for (const [id, result] of settled) results.set(id, result);
    pending = pending.filter(([id]) => isUnavailable(results.get(id)));
    if (!pending.length || retries <= 0) return results;
    if (attempt === 0) {
      const stores = Array.from(new Set(pending.map(([, lookup]) => lookup.store)));
      warn(`The ${stores.join(", ")} store is unavailable; waiting up to ${Math.ceil(storeWaitMs / 1000)}s.`);
    }
    retries -= 1;
    await delay(STORE_RETRY_INTERVAL_MS, signal);
  }
}

async function resolveReferences(parsed, definitions, { policy, warn, ...lookupOptions }) {
  const references = new Map(Object.entries(parsed).map(([name, value]) => [name, findStoreReferences(value)]));
  const failures = new Map();
  const fail = (name, failure) => failures.set(name, [...failures.get(name) ?? [], failure]);
  let stores;
  try {
    stores = parseStoreDefinitions(definitions);
  } catch (failure) {
    warn(policy ? failure.message : `${failure.message} Store references were left unchanged.`);
    for (const [name, found] of references) for (const { store } of found) fail(name, { store, reason: "invalid-definitions" });
    return { parsed, failures };
  }
  const lookups = new Map();
  for (const [name, found] of references) {
    for (const { key, store } of found) {
      const id = JSON.stringify([store, key]);
      if (stores.has(store) && !lookups.has(id)) lookups.set(id, { argv: expandStoreCommand(stores.get(store), key), owner: name, store });
    }
  }
  const results = await runLookups(lookups, { ...lookupOptions, warn });
  for (const [id, lookup] of lookups) {
    const result = results.get(id);
    if (!result.ok) warn(`The ${lookup.store} store lookup for ${lookup.owner} ${lookupFailureDetail(result)}.${policy ? "" : " The reference was left unchanged."}`);
  }
  const resolved = Object.fromEntries(Object.entries(parsed).map(([name, value]) => {
    let next = "";
    let cursor = 0;
    for (const reference of references.get(name)) {
      const result = results.get(JSON.stringify([reference.store, reference.key]));
      if (!result) fail(name, { store: reference.store, reason: "unknown-store" });
      else if (!result.ok) fail(name, { store: reference.store, reason: result.reason, ...result.reason === "exit" ? { exitCode: result.exitCode } : {} });
      next += value.slice(cursor, reference.start) + (result?.ok ? stripTerminalLineEnding(result.stdout) : reference.text);
      cursor = reference.end;
    }
    return [name, next + value.slice(cursor)];
  }));
  return { parsed: resolved, failures };
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

function applyMissingPolicy(parsed, failures, policy, processEnv, override) {
  if (!policy) return;
  const missing = [];
  for (const name of new Set([...Object.keys(parsed), ...policy.names])) {
    const existing = Object.hasOwn(processEnv, name) && processEnv[name] !== undefined;
    const fromFile = Object.hasOwn(parsed, name);
    if (existing && (!override || !fromFile)) continue;
    if (fromFile && !failures.has(name)) continue;
    if (policy.names.has(name) === policy.listedRequired) missing.push(name);
    else Object.defineProperty(parsed, name, { value: "", writable: true, enumerable: true, configurable: true });
  }
  if (missing.length) {
    throw new WorkbenchConfigError(missing, missing.flatMap(name => (failures.get(name) ?? []).map(failure => ({ name, ...failure }))));
  }
}

function checkStoreWait(storeWaitMs) {
  if (typeof storeWaitMs !== "number" || !Number.isFinite(storeWaitMs) || storeWaitMs < 0) {
    throw new TypeError("storeWaitMs must be a finite, non-negative number of milliseconds.");
  }
}

export async function config({
  path: paths = ".env",
  encoding = "utf8",
  override = false,
  processEnv = process.env,
  signal,
  warn = () => {},
  runner = new StoreCommandRunner(),
  delay = sleep,
  storeWaitMs = 0,
  required,
  optional,
  map,
} = {}) {
  signal?.throwIfAborted();
  const policy = missingPolicy(required, optional);
  checkStoreWait(storeWaitMs);
  const { parsed: input, error } = await readParsed(Array.isArray(paths) ? paths : [paths], encoding, override);
  const raw = map ? await map(input) : input;
  signal?.throwIfAborted();
  const definitions = raw.WB_STORES?.trim() || processEnv.WB_STORES?.trim() || DEFAULT_STORE_DEFINITIONS;
  const { parsed, failures } = await resolveReferences(raw, definitions, { runner, signal, warn, policy, storeWaitMs, delay });
  applyMissingPolicy(parsed, failures, policy, processEnv, override);
  const values = policy && !override
    ? Object.fromEntries(Object.entries(parsed).filter(([name]) => !Object.hasOwn(processEnv, name) || processEnv[name] === undefined))
    : parsed;
  dotenv.populate(processEnv, values, { override: policy ? true : override });
  return error ? { parsed, error } : { parsed };
}

export async function arcTree(options) {
  return await WorkbenchArcTree.load(options);
}
