/*
 * Exports:
 * - beginReloadSourceGeneration: stage instruction-source reads for one candidate graph generation. Keywords: reload, source, generation.
 * - completeReloadSourceGeneration/cancelReloadSourceGeneration: publish or discard staged reads without leaking failed candidates. Keywords: reload, activation, rollback.
 * - observeReloadInstructionSource: report one actual Markdown read to the current generation owner. Keywords: instructions, observation, path.
 * - setActiveReloadInstructionObserver: connect future instruction reads to the active dirt owner. Keywords: callback, lifecycle, active.
 */

type SourceListener = (absolutePath: string) => void;

interface ReloadSourceObserverRegistry {
  active: SourceListener | null;
  staging: { paths: Set<string>; token: symbol } | null;
}

const REGISTRY_KEY = Symbol.for("workbench.reload-source-observer");

function registry() {
  const owner = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ReloadSourceObserverRegistry };
  return owner[REGISTRY_KEY] ??= { active: null, staging: null };
}

export function beginReloadSourceGeneration() {
  const token = Symbol("reload-source-generation");
  registry().staging = { paths: new Set(), token };
  return token;
}

export function completeReloadSourceGeneration(token: symbol) {
  const current = registry().staging;
  if (!current || current.token !== token) throw new Error("Reload source generation ownership changed before completion.");
  registry().staging = null;
  return [...current.paths].sort();
}

export function cancelReloadSourceGeneration(token: symbol) {
  const current = registry().staging;
  if (current?.token === token) registry().staging = null;
}

export function observeReloadInstructionSource(absolutePath: string) {
  const current = registry();
  if (current.staging) current.staging.paths.add(absolutePath);
  else current.active?.(absolutePath);
}

export function setActiveReloadInstructionObserver(listener: SourceListener | null) {
  registry().active = listener;
  return () => {
    if (registry().active === listener) registry().active = null;
  };
}
