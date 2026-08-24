/*
 * Exports:
 * - GitignoreMatcher: match paths and directory scopes against ordered gitignore-like patterns. Keywords: gitignore, glob, path, scope.
 * - createGitignoreMatcher: compile reusable gitignore-like pattern text without filesystem ownership. Keywords: matcher, patterns, negation.
 */

export interface GitignoreMatcher {
  matches(relativePath: string): boolean;
  matchesPathOrDescendant(relativePath: string): boolean;
}

interface GitignoreMatcherGroup {
  ignored: boolean;
  pattern: RegExp;
}

function normalizeRelativePath(filePath: string) {
  return String(filePath ?? "").replace(/\\/gu, "/");
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
}

function globPatternToRegExpSource(pattern: string) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const nextCharacter = pattern[index + 1];
    if (character === "*" && nextCharacter === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(character);
  }
  return source;
}

function staticPatternPrefix(pattern: string) {
  const wildcard = pattern.search(/[?*]/u);
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard))
    .replace(/^\/+|\/+$/gu, "");
}

function compileGitignorePattern(rawPattern: string) {
  const trimmedPattern = rawPattern.trim();
  if (!trimmedPattern || trimmedPattern.startsWith("#")) return null;

  const ignored = !trimmedPattern.startsWith("!");
  const patternWithoutPolarity = ignored ? trimmedPattern : trimmedPattern.slice(1).trim();
  if (!patternWithoutPolarity) return null;

  const directoryPattern = patternWithoutPolarity.endsWith("/");
  const anchoredPattern = patternWithoutPolarity.startsWith("/");
  const normalizedPattern = normalizeRelativePath(patternWithoutPolarity)
    .replace(/^\/+|\/+$/gu, "");
  if (!normalizedPattern) return null;

  const hasPathSeparator = normalizedPattern.includes("/");
  const body = globPatternToRegExpSource(normalizedPattern);
  const source = anchoredPattern
    ? directoryPattern ? `^${body}(?:/|$)` : `^${body}$`
    : hasPathSeparator
      ? directoryPattern ? `(^|/)${body}(?:/|$)` : `(^|/)${body}$`
      : `(^|/)${body}(?:/|$)`;

  return { ignored, prefix: staticPatternPrefix(normalizedPattern), source };
}

export function createGitignoreMatcher(contents: string): GitignoreMatcher {
  const groups: GitignoreMatcherGroup[] = [];
  const positivePrefixes: string[] = [];
  let currentGroup: { ignored: boolean; sources: string[] } | null = null;
  for (const line of contents.split(/\r?\n/u)) {
    const compiledPattern = compileGitignorePattern(line);
    if (!compiledPattern) continue;
    if (compiledPattern.ignored && compiledPattern.prefix) positivePrefixes.push(compiledPattern.prefix);

    if (!currentGroup || currentGroup.ignored !== compiledPattern.ignored) {
      if (currentGroup?.sources.length) {
        groups.push({ ignored: currentGroup.ignored, pattern: new RegExp(currentGroup.sources.join("|"), "iu") });
      }
      currentGroup = { ignored: compiledPattern.ignored, sources: [compiledPattern.source] };
      continue;
    }
    currentGroup.sources.push(compiledPattern.source);
  }
  if (currentGroup?.sources.length) {
    groups.push({ ignored: currentGroup.ignored, pattern: new RegExp(currentGroup.sources.join("|"), "iu") });
  }

  const matches = (relativePath: string) => {
    const normalizedPath = normalizeRelativePath(relativePath).replace(/^\/+|\/+$/gu, "");
    let ignored = false;
    for (const group of groups) {
      if (group.pattern.test(normalizedPath)) ignored = group.ignored;
    }
    return ignored;
  };

  return {
    matches,
    matchesPathOrDescendant(relativePath) {
      const normalizedPath = normalizeRelativePath(relativePath).replace(/^\/+|\/+$/gu, "");
      return matches(normalizedPath) || positivePrefixes.some((prefix) => (
        prefix === normalizedPath || prefix.startsWith(`${normalizedPath}/`)
      ));
    },
  };
}
