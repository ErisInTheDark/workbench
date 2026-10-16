/*
 * Exports:
 * - SvgSourceAttribute: one parsed attribute with decoded value and raw source ranges.
 * - SvgSourceElement: one element with its source ranges, attributes and children, indexed in document order.
 * - SvgSourceNode: element, text, comment or CDATA child with raw source range.
 * - SvgSourceTokenKind/SvgSourceToken: sorted, non-overlapping highlight ranges.
 * - SvgSourceError: first structural problem with its line and column.
 * - SvgSourceDocument: parsed root, flat element index and tokens, or the first error.
 * - parseSvgSource: tolerant scanner that always tokenises and builds a tree only for well-formed SVG.
 * - getSvgAttribute: read one decoded attribute value.
 * - findSvgElementAt: deepest element whose source range contains an offset.
 */

export interface SvgSourceAttribute {
  name: string;
  value: string;
  /** Leading whitespace through closing quote. */
  start: number;
  end: number;
  /** Raw value between the quotes. */
  valueStart: number;
  valueEnd: number;
  quote: "\"" | "'";
}

export interface SvgSourceElement {
  index: number;
  name: string;
  start: number;
  end: number;
  /** Offset of the `>` or `/>` closing the open tag; new attributes insert here. */
  openTagClose: number;
  openTagEnd: number;
  selfClosing: boolean;
  attributes: SvgSourceAttribute[];
  children: SvgSourceNode[];
  parentIndex: number | null;
}

export type SvgSourceNode =
  | { kind: "element"; element: SvgSourceElement }
  | { kind: "text" | "comment" | "cdata"; start: number; end: number; text: string };

export type SvgSourceTokenKind = "punctuation" | "tag" | "attribute" | "value" | "comment" | "declaration" | "error";

export interface SvgSourceToken {
  start: number;
  end: number;
  kind: SvgSourceTokenKind;
}

export interface SvgSourceError {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export type SvgSourceDocument =
  | { ok: true; root: SvgSourceElement; elements: SvgSourceElement[]; prolog: SvgSourceNode[]; epilog: SvgSourceNode[]; tokens: SvgSourceToken[] }
  | { ok: false; error: SvgSourceError; tokens: SvgSourceToken[] };

const NAME = /[A-Za-z_:][\w:.-]*/y;
const ATTRIBUTE_NAME = /[^\s=/>"'<]+/y;
const WHITESPACE = /\s*/y;
const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/giu;
const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function decodeEntities(value: string) {
  return value.replace(ENTITY, (_match, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? "";
    const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function match(pattern: RegExp, text: string, offset: number) {
  pattern.lastIndex = offset;
  return pattern.exec(text)?.[0] ?? "";
}

function locate(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

function localName(name: string) {
  return name.slice(name.indexOf(":") + 1);
}

export function parseSvgSource(text: string): SvgSourceDocument {
  const tokens: SvgSourceToken[] = [];
  const elements: SvgSourceElement[] = [];
  const stack: SvgSourceElement[] = [];
  const prolog: SvgSourceNode[] = [];
  const epilog: SvgSourceNode[] = [];
  let root: SvgSourceElement | null = null;
  let error: SvgSourceError | null = null;
  const fail = (message: string, offset: number) => {
    error ??= { message, offset, ...locate(text, offset) };
  };
  const token = (start: number, end: number, kind: SvgSourceTokenKind) => {
    if (end > start) tokens.push({ start, end, kind });
  };
  const place = (node: SvgSourceNode, offset: number) => {
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (node.kind === "element") {
      if (root) fail("An SVG file has exactly one root element.", offset);
      root = node.element;
    } else if (node.kind === "text" && node.text.trim()) fail("Text must be inside the <svg> element.", offset);
    else if (node.kind !== "text") (root ? epilog : prolog).push(node);
  };
  const closeDelimited = (start: number, open: string, close: string, kind: SvgSourceTokenKind, label: string) => {
    const closeAt = text.indexOf(close, start + open.length);
    const end = closeAt < 0 ? text.length : closeAt + close.length;
    token(start, end, kind);
    if (closeAt < 0) fail(`Unclosed ${label}.`, start);
    return end;
  };

  let offset = 0;
  while (offset < text.length) {
    const tagStart = text.indexOf("<", offset);
    if (tagStart !== offset) {
      const end = tagStart < 0 ? text.length : tagStart;
      place({ kind: "text", start: offset, end, text: decodeEntities(text.slice(offset, end)) }, offset);
      offset = end;
      continue;
    }
    if (text.startsWith("<!--", offset)) {
      const end = closeDelimited(offset, "<!--", "-->", "comment", "comment");
      place({ kind: "comment", start: offset, end, text: text.slice(offset + 4, Math.max(offset + 4, end - 3)) }, offset);
      offset = end;
      continue;
    }
    if (text.startsWith("<![CDATA[", offset)) {
      const end = closeDelimited(offset, "<![CDATA[", "]]>", "declaration", "CDATA section");
      place({ kind: "cdata", start: offset, end, text: text.slice(offset + 9, Math.max(offset + 9, end - 3)) }, offset);
      offset = end;
      continue;
    }
    if (text.startsWith("<?", offset) || text.startsWith("<!", offset)) {
      const end = text.startsWith("<?", offset)
        ? closeDelimited(offset, "<?", "?>", "declaration", "declaration")
        : closeDelimited(offset, "<!", ">", "declaration", "declaration");
      if (stack.length) fail("Declarations belong before the <svg> element.", offset);
      else (root ? epilog : prolog).push({ kind: "comment", start: offset, end, text: "" });
      offset = end;
      continue;
    }
    if (text.startsWith("</", offset)) {
      const name = match(NAME, text, offset + 2);
      token(offset, offset + 2, "punctuation");
      token(offset + 2, offset + 2 + name.length, "tag");
      let cursor = offset + 2 + name.length;
      cursor += match(WHITESPACE, text, cursor).length;
      const open = stack.pop();
      if (text[cursor] !== ">") {
        fail("Expected > to finish the closing tag.", cursor);
        token(cursor, cursor + 1, "error");
        offset = cursor + 1;
        continue;
      }
      token(cursor, cursor + 1, "punctuation");
      if (!open) fail(`Unexpected closing tag </${name}>.`, offset);
      else if (open.name !== name) fail(`Expected </${open.name}> but found </${name}>.`, offset);
      else open.end = cursor + 1;
      offset = cursor + 1;
      continue;
    }

    const name = match(NAME, text, offset + 1);
    token(offset, offset + 1, "punctuation");
    if (!name) {
      fail("Expected an element name after <.", offset);
      token(offset + 1, offset + 2, "error");
      offset += 1;
      continue;
    }
    token(offset + 1, offset + 1 + name.length, "tag");
    const element: SvgSourceElement = {
      index: elements.length, name, start: offset, end: text.length, openTagClose: text.length, openTagEnd: text.length,
      selfClosing: false, attributes: [], children: [], parentIndex: stack.at(-1)?.index ?? null,
    };
    elements.push(element);
    let cursor = offset + 1 + name.length;
    for (;;) {
      const attributeStart = cursor;
      cursor += match(WHITESPACE, text, cursor).length;
      if (cursor >= text.length) {
        fail(`Unclosed <${name}> tag.`, offset);
        break;
      }
      if (text.startsWith("/>", cursor) || text[cursor] === ">") {
        element.openTagClose = cursor;
        element.selfClosing = text[cursor] === "/";
        element.openTagEnd = cursor + (element.selfClosing ? 2 : 1);
        token(cursor, element.openTagEnd, "punctuation");
        cursor = element.openTagEnd;
        break;
      }
      const attributeName = match(ATTRIBUTE_NAME, text, cursor);
      if (!attributeName || cursor === attributeStart) {
        fail(attributeName ? "Attributes must be separated by whitespace." : `Unexpected ${JSON.stringify(text[cursor])} in <${name}>.`, cursor);
        token(cursor, cursor + Math.max(1, attributeName.length), "error");
        cursor += Math.max(1, attributeName.length);
        continue;
      }
      token(cursor, cursor + attributeName.length, "attribute");
      cursor += attributeName.length;
      cursor += match(WHITESPACE, text, cursor).length;
      if (text[cursor] !== "=") {
        fail(`Attribute ${attributeName} needs a ="value".`, cursor);
        continue;
      }
      token(cursor, cursor + 1, "punctuation");
      cursor += 1;
      cursor += match(WHITESPACE, text, cursor).length;
      const quote = text[cursor];
      if (quote !== "\"" && quote !== "'") {
        fail(`Attribute ${attributeName} value must be quoted.`, cursor);
        continue;
      }
      const closeQuote = text.indexOf(quote, cursor + 1);
      const valueEnd = closeQuote < 0 ? text.length : closeQuote;
      token(cursor, Math.min(text.length, valueEnd + 1), "value");
      if (closeQuote < 0) fail(`Unclosed ${attributeName} value.`, cursor);
      element.attributes.push({
        name: attributeName, value: decodeEntities(text.slice(cursor + 1, valueEnd)), start: attributeStart,
        end: Math.min(text.length, valueEnd + 1), valueStart: cursor + 1, valueEnd, quote,
      });
      cursor = valueEnd + 1;
    }
    place({ kind: "element", element }, offset);
    if (element.selfClosing) element.end = element.openTagEnd;
    else stack.push(element);
    offset = cursor;
  }
  for (const open of stack.reverse()) fail(`Unclosed <${open.name}> element.`, open.start);
  const parsedRoot = root as SvgSourceElement | null;
  if (!error && !parsedRoot) fail("Add an <svg> root element.", 0);
  if (!error && parsedRoot && localName(parsedRoot.name) !== "svg") fail("The root element must be <svg>.", parsedRoot.start);
  return error || !parsedRoot
    ? { ok: false, error: error ?? { message: "Add an <svg> root element.", offset: 0, line: 1, column: 1 }, tokens }
    : { ok: true, root: parsedRoot, elements, prolog, epilog, tokens };
}

export function getSvgAttribute(element: SvgSourceElement, name: string) {
  return element.attributes.find(attribute => attribute.name === name)?.value ?? null;
}

export function findSvgElementAt(elements: readonly SvgSourceElement[], offset: number) {
  let found: SvgSourceElement | null = null;
  for (const element of elements) {
    if (element.start <= offset && offset < element.end && (!found || element.start >= found.start)) found = element;
  }
  return found;
}
