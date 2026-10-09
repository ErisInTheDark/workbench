/*
 * Exports:
 * - RipgrepGlobSpec: one -g/--iglob argument with its case behaviour.
 * - RipgrepPathFilter: decide whether a cwd-relative file path passes glob and type filters.
 * - compileRipgrepGlob: compile one rg-style glob (braces, classes, **, ! negation) into a path matcher.
 * - createRipgrepPathFilter: combine ordered globs and file types with rg precedence.
 */
import { RIPGREP_FILE_TYPES } from "./ripgrep-file-types";

export interface RipgrepGlobSpec {
  glob: string;
  caseInsensitive: boolean;
}

export type RipgrepPathFilter = (relativePath: string) => boolean;

interface CompiledGlob {
  negated: boolean;
  pattern: RegExp;
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

/** Matches a cwd-relative file path, or any of its ancestor directories, against one glob. */
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
  return {
    negated,
    pattern: new RegExp(`${prefix}${globBodyToSource(glob)}${suffix}`, caseInsensitive ? "iu" : "u"),
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
