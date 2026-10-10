/*
 * Exports:
 * - GitArcEditWorkFile/GitArcEditWorkInput/GitArcEditWorkChange/GitArcEditWorkResult: worker-safe snapshot in, renames and new text out.
 * - runGitArcEditOperations: apply ordered moves (with agent-defined reference rewrites) and regex replacements to an in-memory file set.
 * - underGitArcEditRoots/createGitArcEditPathFilter: shared root and glob selection used by planning and operations.
 */
import path from "node:path";

import type { GitArcEditOperation, GitArcEditReferenceSpec } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { createRipgrepPathFilter } from "workbench-shared/workbench/ripgrep/ripgrep-globs";

export interface GitArcEditWorkFile {
  ignored: boolean;
  path: string;
  /** Null when the file may move but never changes content: binary, oversized, unreadable as UTF-8, or never read. */
  text: string | null;
}

export interface GitArcEditWorkInput {
  caseInsensitive: boolean;
  files: GitArcEditWorkFile[];
  /** Repository-relative operations; "." roots select the whole repository. */
  operations: GitArcEditOperation[];
}

export interface GitArcEditWorkChange {
  origin: string;
  path: string;
  /** Present only when the content changed. */
  text?: string;
}

export interface GitArcEditWorkResult {
  changes: GitArcEditWorkChange[];
  warnings: string[];
}

interface VirtualFile {
  ignored: boolean;
  origin: string;
  original: string | null;
  text: string | null;
}

type Files = Map<string, VirtualFile>;

type ResolutionForm =
  | { kind: "exact" }
  | { extension: string; kind: "append" }
  | { file: string; kind: "index" }
  | { from: string; kind: "swap"; to: string };

const posix = path.posix;

export function underGitArcEditRoots(filePath: string, roots: readonly string[]) {
  return roots.some(root => root === "." || filePath === root || filePath.startsWith(`${root}/`));
}

export function createGitArcEditPathFilter(globs: readonly string[]) {
  return createRipgrepPathFilter({ globs: globs.map(glob => ({ caseInsensitive: false, glob })), types: [], typesNot: [] });
}

const underRoots = underGitArcEditRoots;
const pathFilter = createGitArcEditPathFilter;

function compile(pattern: string, flags: string, label: string) {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Invalid ${label} regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function lineAt(text: string, offset: number) {
  let line = 1;
  for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) line += 1;
  return line;
}

/** Repository-relative POSIX path, or null when it escapes the repository. */
function normalizeRelative(value: string) {
  const normalized = posix.normalize(value).replace(/\/+$/u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) return null;
  return normalized;
}

function relativeBetween(fromDirectory: string, to: string) {
  return posix.relative(`/${fromDirectory === "." ? "" : fromDirectory}`, `/${to}`);
}

function resolveDirectMoves(files: Files, from: string, to: string) {
  if (from === to) throw new Error(`Move source and destination are identical: ${from}`);
  if (to.startsWith(`${from}/`)) throw new Error(`Move destination is inside its source: ${from} -> ${to}`);
  if (files.has(from)) return [{ from, to }];
  const contained = [...files.keys()].filter(candidate => candidate.startsWith(`${from}/`)).sort();
  if (!contained.length) throw new Error(`Move source does not exist: ${from}`);
  return contained.map(candidate => ({ from: candidate, to: `${to}${candidate.slice(from.length)}` }));
}

function resolvePatternMoves(files: Files, operation: Extract<GitArcEditOperation, { kind: "move" }>) {
  const expression = compile(operation.pathPattern!, "u", "path");
  const mappings = [...files.entries()]
    .filter(([candidate, file]) => underRoots(candidate, operation.roots!) && (operation.includeIgnored || !file.ignored))
    .filter(([candidate]) => expression.test(candidate))
    .map(([candidate]) => ({ from: candidate, to: candidate.replace(expression, operation.pathReplacement!) }))
    // A pattern that leaves a matched path unchanged selects nothing to move there.
    .filter(({ from, to }) => from !== to);
  if (!mappings.length) throw new Error(`Move pattern ${JSON.stringify(operation.pathPattern)} matched no files to move.`);
  return mappings.sort((left, right) => left.from.localeCompare(right.from));
}

function validateMoves(files: Files, mappings: Array<{ from: string; to: string }>, caseInsensitive: boolean) {
  const key = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  const sources = new Set(mappings.map(({ from }) => key(from)));
  const destinations = new Set<string>();
  const existing = new Map([...files.keys()].map(candidate => [key(candidate), candidate]));
  for (const mapping of mappings) {
    const to = normalizeRelative(mapping.to);
    if (!to) throw new Error(`Move destination must stay inside the repository: ${mapping.to}`);
    mapping.to = to;
    const destination = key(to);
    if (destinations.has(destination)) throw new Error(`Move destination is repeated: ${to}`);
    destinations.add(destination);
    const occupant = existing.get(destination);
    if (occupant && !sources.has(destination)) throw new Error(`Move destination already exists: ${to}`);
    const prefix = `${destination}/`;
    if ([...existing.keys()].some(candidate => candidate.startsWith(prefix) && !sources.has(candidate))) {
      throw new Error(`Move destination is a folder with files: ${to}`);
    }
  }
}

class ReferenceRewriter {
  private readonly aliases: Array<{ prefix: string; target: string }>;
  private readonly expression: RegExp;
  private readonly filter: (filePath: string) => boolean;

  constructor(
    private readonly spec: GitArcEditReferenceSpec,
    private readonly files: Files,
    private readonly moved: ReadonlyMap<string, string>,
    private readonly warnings: string[],
  ) {
    if (!/\(\?<path>/u.test(spec.pattern)) throw new Error(`Reference pattern ${JSON.stringify(spec.pattern)} needs a (?<path>...) named group.`);
    this.expression = compile(spec.pattern, "dgu", "reference");
    this.filter = pathFilter(spec.globs);
    this.aliases = Object.entries(spec.aliases)
      .map(([prefix, target]) => ({ prefix, target: target.replace(/\/+$/u, "") || "." }))
      .sort((left, right) => right.prefix.length - left.prefix.length);
  }

  rewriteAll() {
    for (const [filePath, file] of this.files) {
      if (file.text === null || (file.ignored && !this.spec.includeIgnored) || !this.filter(filePath)) continue;
      if (!underRoots(filePath, this.spec.roots) && !this.moved.has(filePath)) continue;
      const text = file.text;
      const edits: Array<{ end: number; start: number; value: string }> = [];
      for (const match of text.matchAll(this.expression)) {
        const span = match.indices?.groups?.path;
        const specifier = match.groups?.path;
        if (!span || specifier === undefined) continue;
        const rewritten = this.rewrite(specifier, filePath, this.moved.get(filePath) ?? filePath);
        if (rewritten.warning) this.warnings.push(`${filePath}:${lineAt(text, span[0])} ${rewritten.warning}`);
        if (rewritten.value !== undefined && rewritten.value !== specifier) edits.push({ end: span[1], start: span[0], value: rewritten.value });
      }
      if (!edits.length) continue;
      let next = text;
      for (const edit of edits.sort((left, right) => right.start - left.start)) {
        next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`;
      }
      file.text = next;
    }
  }

  private exists(candidate: string) {
    return this.files.has(candidate);
  }

  private resolve(resolved: string): { form: ResolutionForm; target: string } | null {
    if (this.exists(resolved)) return { form: { kind: "exact" }, target: resolved };
    for (const extension of this.spec.extensions) {
      if (this.exists(`${resolved}${extension}`)) return { form: { extension, kind: "append" }, target: `${resolved}${extension}` };
    }
    for (const name of this.spec.indexNames) {
      for (const extension of ["", ...this.spec.extensions]) {
        const candidate = `${resolved}/${name}${extension}`;
        if (this.exists(candidate)) return { form: { file: `${name}${extension}`, kind: "index" }, target: candidate };
      }
    }
    const extension = posix.extname(resolved);
    if (extension) {
      for (const replacement of this.spec.extensions) {
        const candidate = `${resolved.slice(0, -extension.length)}${replacement}`;
        if (replacement !== extension && this.exists(candidate)) {
          return { form: { from: extension, kind: "swap", to: replacement }, target: candidate };
        }
      }
    }
    return null;
  }

  private applyForm(target: string, form: ResolutionForm) {
    if (form.kind === "exact") return target;
    if (form.kind === "append") return target.endsWith(form.extension) ? target.slice(0, -form.extension.length) : null;
    if (form.kind === "index") return posix.basename(target) === form.file ? posix.dirname(target) : null;
    return target.endsWith(form.to) ? `${target.slice(0, -form.to.length)}${form.from}` : null;
  }

  private rewrite(specifier: string, oldFile: string, newFile: string): { value?: string; warning?: string } {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const alias = relative ? null : this.aliases.find(({ prefix }) => specifier.startsWith(prefix)) ?? null;
    if (!relative && !alias) return {};
    const joined = alias
      ? posix.join(alias.target, specifier.slice(alias.prefix.length))
      : posix.join(posix.dirname(oldFile), specifier);
    const resolved = normalizeRelative(joined);
    if (!resolved) return {};
    const resolution = this.resolve(resolved);
    if (!resolution) return {};
    const newTarget = this.moved.get(resolution.target) ?? resolution.target;
    if (newTarget === resolution.target && newFile === oldFile) return {};
    const formed = this.applyForm(newTarget, resolution.form);
    const location = formed ?? newTarget;
    const formWarning = formed === null ? `could not keep the specifier form of ${JSON.stringify(specifier)}; pointed it at the moved file exactly` : undefined;
    if (alias) {
      const inside = alias.target === "." ? location : location === alias.target ? "" : location.startsWith(`${alias.target}/`) ? location.slice(alias.target.length + 1) : null;
      if (inside !== null) {
        const value = alias.prefix.endsWith("/") || !inside ? `${alias.prefix}${inside}` : `${alias.prefix}/${inside}`;
        return { value, ...(formWarning ? { warning: formWarning } : {}) };
      }
    }
    let value = relativeBetween(posix.dirname(newFile), location) || ".";
    if (!value.startsWith("../") && value !== "..") value = value === "." ? "./" : `./${value}`;
    const aliasWarning = alias ? `alias target left the ${alias.prefix} root; rewrote ${JSON.stringify(specifier)} as relative` : undefined;
    const warning = [aliasWarning, formWarning].filter(Boolean).join("; ");
    return { value, ...(warning ? { warning } : {}) };
  }
}

function applyMove(files: Files, operation: Extract<GitArcEditOperation, { kind: "move" }>, caseInsensitive: boolean, warnings: string[]) {
  const mappings = operation.from !== undefined
    ? resolveDirectMoves(files, operation.from, operation.to!)
    : resolvePatternMoves(files, operation);
  validateMoves(files, mappings, caseInsensitive);
  const moved = new Map(mappings.map(({ from, to }) => [from, to]));
  for (const spec of operation.references) new ReferenceRewriter(spec, files, moved, warnings).rewriteAll();
  const relocated = mappings.map(({ from, to }) => [to, files.get(from)!] as const);
  for (const { from } of mappings) files.delete(from);
  for (const [to, file] of relocated) files.set(to, file);
}

function applyReplace(files: Files, operation: Extract<GitArcEditOperation, { kind: "replace" }>) {
  const expression = compile(operation.pattern, `gu${operation.flags}`, "replace");
  const filter = pathFilter(operation.globs);
  for (const [filePath, file] of files) {
    if (file.text === null || (file.ignored && !operation.includeIgnored)) continue;
    if (!underRoots(filePath, operation.roots) || !filter(filePath)) continue;
    file.text = file.text.replace(expression, operation.replacement);
  }
}

export function runGitArcEditOperations(input: GitArcEditWorkInput): GitArcEditWorkResult {
  const files: Files = new Map(input.files.map(file => [file.path, {
    ignored: file.ignored, origin: file.path, original: file.text, text: file.text,
  }]));
  const warnings: string[] = [];
  for (const operation of input.operations) {
    if (operation.kind === "move") applyMove(files, operation, input.caseInsensitive, warnings);
    else applyReplace(files, operation);
  }
  const changes = [...files.entries()].flatMap(([filePath, file]): GitArcEditWorkChange[] => {
    const textChanged = file.text !== file.original;
    if (filePath === file.origin && !textChanged) return [];
    return [{ origin: file.origin, path: filePath, ...(textChanged && file.text !== null ? { text: file.text } : {}) }];
  });
  return { changes: changes.sort((left, right) => left.path.localeCompare(right.path)), warnings };
}
