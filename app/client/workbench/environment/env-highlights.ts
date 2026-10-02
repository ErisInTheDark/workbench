/*
 * Exports:
 * - EnvHighlightKind: semantic token kinds in a dotenv file.
 * - EnvHighlightToken: one sorted, non-overlapping token range.
 * - tokenizeEnv: tokenise dotenv text for display, marking `${store:key}` references and `wb` keys missing from the store.
 * - envHighlightClassName: theme classes for each token kind.
 */
export type EnvHighlightKind = "comment" | "export" | "key" | "operator" | "string" | "reference" | "missing-reference";

export interface EnvHighlightToken {
  start: number;
  end: number;
  kind: EnvHighlightKind;
}

const REFERENCE = /\$\{([A-Za-z0-9_-]+):([^}\r\n]+)\}/gu;
const ASSIGNMENT = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*=)/u;

const CLASS_NAMES: Record<EnvHighlightKind, string> = {
  comment: "text-fg/muted italic",
  export: "text-fg/muted",
  key: "text-accent",
  operator: "text-fg/muted",
  string: "text-success",
  reference: "rounded-[0.28em] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent",
  "missing-reference": "rounded-[0.28em] bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger",
};

export function envHighlightClassName(kind: EnvHighlightKind) {
  return CLASS_NAMES[kind];
}

/** Pushes `kind` over [start, end), splitting it around store references. */
function pushValue(tokens: EnvHighlightToken[], text: string, start: number, end: number, kind: "string" | null, knownWbKeys: ReadonlySet<string> | null) {
  let cursor = start;
  for (const match of text.slice(start, end).matchAll(REFERENCE)) {
    const referenceStart = start + match.index;
    if (kind && referenceStart > cursor) tokens.push({ start: cursor, end: referenceStart, kind });
    const missing = match[1] === "wb" && knownWbKeys !== null && !knownWbKeys.has(match[2]!);
    cursor = referenceStart + match[0].length;
    tokens.push({ start: referenceStart, end: cursor, kind: missing ? "missing-reference" : "reference" });
  }
  if (kind && end > cursor) tokens.push({ start: cursor, end, kind });
}

/** `knownWbKeys` is null while the store is unknown, so no reference is marked missing. */
export function tokenizeEnv(text: string, knownWbKeys: ReadonlySet<string> | null): EnvHighlightToken[] {
  const tokens: EnvHighlightToken[] = [];
  let offset = 0;
  let openQuote: string | null = null;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    let cursor = offset;
    if (openQuote) {
      const close = line.indexOf(openQuote);
      const end = close < 0 ? lineEnd : offset + close + 1;
      pushValue(tokens, text, offset, end, "string", knownWbKeys);
      if (close >= 0) openQuote = null;
      offset = lineEnd + 1;
      continue;
    }
    if (/^[ \t]*#/u.test(line)) {
      tokens.push({ start: offset + line.indexOf("#"), end: lineEnd, kind: "comment" });
      offset = lineEnd + 1;
      continue;
    }
    const assignment = ASSIGNMENT.exec(line);
    if (assignment) {
      const [, indent, exported, key, operator] = assignment;
      cursor += indent!.length;
      if (exported) tokens.push({ start: cursor, end: cursor + exported.length, kind: "export" });
      cursor += exported?.length ?? 0;
      tokens.push({ start: cursor, end: cursor + key!.length, kind: "key" });
      cursor += key!.length;
      tokens.push({ start: cursor + operator!.length - 1, end: cursor + operator!.length, kind: "operator" });
      cursor += operator!.length;
      const rest = line.slice(cursor - offset);
      const leading = rest.length - rest.trimStart().length;
      const quote = rest.trimStart()[0];
      if (quote === "\"" || quote === "'" || quote === "`") {
        const valueStart = cursor + leading;
        const close = line.indexOf(quote, valueStart - offset + 1);
        const end = close < 0 ? lineEnd : offset + close + 1;
        pushValue(tokens, text, valueStart, end, "string", knownWbKeys);
        if (close < 0) openQuote = quote;
        else {
          const comment = line.slice(close + 1).search(/[ \t]#/u);
          if (comment >= 0) tokens.push({ start: offset + close + 1 + comment + 1, end: lineEnd, kind: "comment" });
        }
      } else {
        const comment = rest.search(/(?:^|[ \t])#/u);
        const valueEnd = comment < 0 ? lineEnd : cursor + comment;
        pushValue(tokens, text, cursor, valueEnd, null, knownWbKeys);
        if (comment >= 0) tokens.push({ start: cursor + rest.indexOf("#", comment), end: lineEnd, kind: "comment" });
      }
    }
    offset = lineEnd + 1;
  }
  return tokens.filter(token => token.end > token.start);
}
