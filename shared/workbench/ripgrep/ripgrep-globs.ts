/*
 * Exports:
 * - RipgrepGlobSpec: one -g/--iglob argument with its case behaviour.
 * - RipgrepPathFilter: decide whether a cwd-relative file path passes glob and type filters.
 * - RipgrepDirectoryPruner: decide whether a walk may skip a cwd-relative directory outright.
 * - compileRipgrepGlob: compile one rg-style glob (braces, classes, **, ! negation) into file and directory matchers.
 * - createRipgrepPathFilter: combine ordered globs and file types with rg precedence.
 * - createRipgrepDirectoryPruner: skip directories under which no file could pass the ordered globs.
 */
import { RIPGREP_FILE_TYPES } from "./ripgrep-file-types";

export interface RipgrepGlobSpec {
  glob: string;
  caseInsensitive: boolean;
}

export type RipgrepPathFilter = (relativePath: string) => boolean;
export type RipgrepDirectoryPruner = (relativeDirectory: string) => boolean;

interface CompiledGlob {
  negated: boolean;
  pattern: RegExp;
  /** Matches a directory exactly when `pattern` matches every path beneath it. */
  directory: RegExp;
  /** False only when `pattern` provably matches nothing at or beneath a directory. */
  reachesBeneath: (relativeDirectory: string) => boolean;
}

// Escapes only characters that are syntax in u-mode regex; escaping others (like "-") is a u-mode error.
function escapeRegExp(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function globBodyToSource(glob: string) {
  let index = 0;
  const parse = (insideBraces: boolean): string => {
    let source = "";
    const alternatives: string[] = [];
    while (index < glob.length) {
      const character = glob[index]!;
      if (insideBraces && character === "}") {
        index += 1;
        alternatives.push(source);
        return `(?:${alternatives.join("|")})`;
      }
      if (insideBraces && character === ",") {
        index += 1;
        alternatives.push(source);
        source = "";
        continue;
      }
      if (character === "{") {
        index += 1;
        source += parse(true);
        continue;
      }
      if (character === "\\" && index + 1 < glob.length) {
        source += escapeRegExp(glob[index + 1]!);
        index += 2;
        continue;
      }
      if (character === "*") {
        if (glob[index + 1] === "*") {
          const atSegmentStart = index === 0 || glob[index - 1] === "/";
          const next = glob[index + 2];
          if (atSegmentStart && next === "/") {
            source += "(?:.*/)?";
            index += 3;
            continue;
          }
          if (atSegmentStart && next === undefined) {
            source += ".*";
            index += 2;
            continue;
          }
          source += "[^/]*";
          index += 2;
          continue;
        }
        source += "[^/]*";
        index += 1;
        continue;
      }
      if (character === "?") {
        source += "[^/]";
        index += 1;
        continue;
      }
      if (character === "[") {
        const close = glob.indexOf("]", index + 2);
        if (close < 0) {
          source += "\\[";
          index += 1;
          continue;
        }
        let content = glob.slice(index + 1, close);
        const negated = content.startsWith("!") || content.startsWith("^");
        if (negated) content = content.slice(1);
        source += `[${negated ? "^/" : ""}${content.replace(/[\\\]]/gu, "\\$&")}]`;
        index = close + 1;
        continue;
      }
      source += escapeRegExp(character);
      index += 1;
    }
    if (insideBraces) throw new Error(`Unterminated "{" in glob: ${glob}`);
    return source;
  };
  return parse(false);
}

/**
 * Matches a cwd-relative file path, or any of its ancestor directories, against one glob. `directory` matches a directory
 * only when it matches every path beneath it: the match ends at the directory's end or an earlier slash, so it is a prefix
 * match of each descendant. A trailing `/**` covers everything beneath what precedes it.
 */
export function compileRipgrepGlob(rawGlob: string, caseInsensitive = false): CompiledGlob {
  let glob = rawGlob;
  const negated = glob.startsWith("!");
  if (negated) glob = glob.slice(1);
  glob = glob.replace(/^\.\//u, "");
  const directoryOnly = glob.endsWith("/");
  glob = glob.replace(/\/+$/u, "");
  const anchored = glob.includes("/");
  glob = glob.replace(/^\/+/u, "");
  if (!glob) throw new Error(`Empty glob: ${rawGlob}`);
  const prefix = anchored ? "^" : "(?:^|/)";
  const suffix = directoryOnly ? "/" : "(?:/|$)";
  const flags = caseInsensitive ? "iu" : "u";
  const directoryGlob = glob.endsWith("/**") ? glob.slice(0, -3) : glob;
  return {
    negated,
    pattern: new RegExp(`${prefix}${globBodyToSource(glob)}${suffix}`, flags),
    directory: new RegExp(`${prefix}${globBodyToSource(directoryGlob)}(?:/|$)`, flags),
    reachesBeneath: anchored ? segmentReach(glob, flags) : () => true,
  };
}

/** Whether a `/` follows an escape or sits inside a brace group or class; such globs do not split into path segments. */
function hasUnsplittableSlash(glob: string) {
  let braces = 0;
  let inClass = false;
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "\\") return glob.includes("/", index);
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "/" && (braces || inClass)) return true;
  }
  return false;
}

/**
 * For an anchored glob: whether it could match some path at or beneath a directory, by stepping its segments along the
 * directory's (a `**` segment spans any number). It can when it completes within the directory (then it matches
 * everything beneath) or is still alive at the directory's end (its remaining segments can name something beneath).
 * Unanchored globs match a name at any depth, so they always can; so does any glob this cannot split.
 */
function segmentReach(glob: string, flags: string): (relativeDirectory: string) => boolean {
  if (hasUnsplittableSlash(glob)) return () => true;
  const segments = glob.split("/").map(segment => segment === "**" ? "**" as const : new RegExp(`^${globBodyToSource(segment)}$`, flags));
  const close = (states: Set<number>) => {
    for (const state of states) if (segments[state] === "**") states.add(state + 1);
    return states;
  };
  return (relativeDirectory) => {
    let states = close(new Set([0]));
    for (const name of relativeDirectory.split("/")) {
      if (states.has(segments.length)) return true;
      const next = new Set<number>();
      for (const state of states) {
        const segment = segments[state]!;
        if (segment === "**") next.add(state);
        else if (segment.test(name)) next.add(state + 1);
      }
      states = close(next);
      if (!states.size) return false;
    }
    return true;
  };
}

/**
 * Whether a walk can skip a cwd-relative directory because no file beneath it could pass the globs. Later globs win, so
 * reading from the last: an include that could reach beneath keeps the directory, and an exclusion covering it skips it.
 * When every include is unreachable, nothing beneath could be admitted at all.
 */
export function createRipgrepDirectoryPruner(globs: readonly RipgrepGlobSpec[]): RipgrepDirectoryPruner {
  const compiled = globs.map(spec => compileRipgrepGlob(spec.glob, spec.caseInsensitive));
  const hasPositiveGlob = compiled.some(glob => !glob.negated);
  return (relativeDirectory) => {
    for (let index = compiled.length - 1; index >= 0; index -= 1) {
      const glob = compiled[index]!;
      if (!glob.negated) {
        if (glob.reachesBeneath(relativeDirectory)) return false;
      } else if (glob.directory.test(relativeDirectory)) {
        return true;
      }
    }
    return hasPositiveGlob;
  };
}

export function createRipgrepPathFilter(options: {
  globs: readonly RipgrepGlobSpec[];
  types: readonly string[];
  typesNot: readonly string[];
}): RipgrepPathFilter {
  const globs = options.globs.map(spec => compileRipgrepGlob(spec.glob, spec.caseInsensitive));
  const hasPositiveGlob = globs.some(glob => !glob.negated);
  const typePatterns = (names: readonly string[]) => names.flatMap(name => (RIPGREP_FILE_TYPES[name] ?? [])
    .map(glob => compileRipgrepGlob(glob).pattern));
  const included = typePatterns(options.types);
  const excluded = typePatterns(options.typesNot);
  return (relativePath) => {
    // Later globs win, as in rg.
    let verdict: boolean | null = null;
    for (const glob of globs) {
      if (glob.pattern.test(relativePath)) verdict = !glob.negated;
    }
    if (verdict === false || (verdict === null && hasPositiveGlob)) return false;
    if (included.length && !included.some(pattern => pattern.test(relativePath))) return false;
    return !excluded.some(pattern => pattern.test(relativePath));
  };
}
