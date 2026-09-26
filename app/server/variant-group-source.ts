/*
 * Exports:
 * - expandVariantGroupsInSource: expand grouped Tailwind classes in browser source with a source map.
 */
import path from "node:path";
import MagicString from "magic-string";
import ts from "typescript";

interface ClassToken {
  text: string;
  start: number;
  end: number;
}

function classTokens(value: string): ClassToken[] {
  const tokens: ClassToken[] = [];
  let start = -1;
  let brackets = 0;
  let parentheses = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (start < 0 && !/\s/u.test(char)) start = index;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (!brackets && char === "(") parentheses++;
    else if (!brackets && char === ")") parentheses--;
    if (!brackets && !parentheses && /\s/u.test(char) && start >= 0) {
      tokens.push({ text: value.slice(start, index), start, end: index });
      start = -1;
    }
  }
  if (start >= 0) tokens.push({ text: value.slice(start), start, end: value.length });
  return tokens;
}

function groupOpening(token: string) {
  let brackets = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < token.length - 1; index++) {
    const char = token[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[") brackets++;
    else if (char === "]") brackets--;
    if (!brackets && char === ":" && token[index + 1] === "(") return index;
  }
  return -1;
}

function normalizeBracketWhitespace(token: string) {
  let brackets = 0;
  let opening = -1;
  let cursor = 0;
  let result = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < token.length; index++) {
    const char = token[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[" && brackets++ === 0) opening = index;
    else if (char === "]" && brackets > 0 && --brackets === 0) {
      const body = token.slice(opening + 1, index);
      const value = body.trim().replace(/^([\w-]+):\s+/u, "$1:").replace(/\s+/gu, "_");
      result += token.slice(cursor, opening + 1) + value + "]";
      cursor = index + 1;
    }
  }
  return result + token.slice(cursor);
}

function expandToken(token: string, prefix = ""): string {
  const opening = groupOpening(token);
  if (opening < 0) return `${prefix}${normalizeBracketWhitespace(token)}`;
  if (!token.endsWith(")") || opening === 0) {
    throw new Error(`Invalid Tailwind variant group: ${token}`);
  }
  const nestedPrefix = `${prefix}${token.slice(0, opening)}:`;
  const inner = token.slice(opening + 2, -1);
  const children = classTokens(inner);
  if (!children.length) throw new Error(`Empty Tailwind variant group: ${token}`);
  return children.map(child => expandToken(child.text, nestedPrefix)).join(" ");
}

function expandClasses(value: string) {
  const tokens = classTokens(value);
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    result += value.slice(cursor, token.start);
    result += expandToken(token.text);
    cursor = token.end;
  }
  return result + value.slice(cursor);
}

function literalContentRange(node: ts.Node, sourceFile: ts.SourceFile) {
  const start = node.getStart(sourceFile);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || node.kind === ts.SyntaxKind.TemplateTail) {
    return { start: start + 1, end: node.end - 1 };
  }
  if (node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle) {
    return { start: start + 1, end: node.end - 2 };
  }
  return null;
}

export function expandVariantGroupsInSource(source: string, filePath: string) {
  if (!source.includes(":(") && !source.includes("[")) return { code: source, map: null };
  const scriptKind = /\.tsx$/u.test(filePath) ? ts.ScriptKind.TSX
    : /\.jsx$/u.test(filePath) ? ts.ScriptKind.JSX
      : /\.js$/u.test(filePath) ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const output = new MagicString(source);
  let changed = false;
  function visit(node: ts.Node) {
    const range = literalContentRange(node, sourceFile);
    if (range) {
      const original = source.slice(range.start, range.end);
      if (original.includes(":(") || original.includes("[")) {
        const expanded = expandClasses(original);
        if (expanded !== original) {
          output.overwrite(range.start, range.end, expanded);
          changed = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return changed
    ? { code: output.toString(), map: output.generateMap({ source: path.basename(filePath), includeContent: true, hires: true }).toString() }
    : { code: source, map: null };
}
