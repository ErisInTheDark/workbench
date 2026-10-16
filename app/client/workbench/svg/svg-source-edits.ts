/*
 * Exports:
 * - applySvgAttributeEdits: splice attribute values into one element's open tag, leaving the rest of the source untouched.
 * - removeSvgElement: delete one element, including its line when it sits alone on it.
 * - duplicateSvgElement: copy one element directly after itself on a matching indented line.
 * - formatSvgSource: re-indent a well-formed document, keeping raw attribute values, text and comments.
 */
import type { SvgAttributeEdit } from "./svg-geometry";
import { parseSvgSource, type SvgSourceElement, type SvgSourceNode } from "./svg-source";

const FORMAT_LINE_LIMIT = 100;
const INDENT = "  ";

function escapeAttribute(value: string, quote: "\"" | "'") {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(quote === "\"" ? /"/gu : /'/gu, quote === "\"" ? "&quot;" : "&apos;");
}

export function applySvgAttributeEdits(text: string, element: SvgSourceElement, edits: readonly SvgAttributeEdit[]) {
  const splices: Array<{ start: number; end: number; text: string }> = [];
  for (const edit of edits) {
    const existing = element.attributes.find(attribute => attribute.name === edit.name);
    splices.push(existing
      ? { start: existing.valueStart, end: existing.valueEnd, text: escapeAttribute(edit.value, existing.quote) }
      : { start: element.openTagClose, end: element.openTagClose, text: ` ${edit.name}="${escapeAttribute(edit.value, "\"")}"` });
  }
  splices.sort((left, right) => right.start - left.start);
  let next = text;
  for (const splice of splices) next = next.slice(0, splice.start) + splice.text + next.slice(splice.end);
  return next;
}

function lineBounds(text: string, element: SvgSourceElement) {
  const lineStart = text.lastIndexOf("\n", element.start - 1) + 1;
  const newline = text.indexOf("\n", element.end);
  const lineEnd = newline < 0 ? text.length : newline;
  const before = text.slice(lineStart, element.start);
  const after = text.slice(element.end, lineEnd);
  return { lineStart, lineEnd, newline, before, alone: !before.trim() && !after.trim() };
}

export function removeSvgElement(text: string, element: SvgSourceElement) {
  const line = lineBounds(text, element);
  if (!line.alone) return text.slice(0, element.start) + text.slice(element.end);
  return text.slice(0, line.lineStart) + text.slice(line.newline < 0 ? line.lineEnd : line.newline + 1);
}

export function duplicateSvgElement(text: string, element: SvgSourceElement) {
  const line = lineBounds(text, element);
  const separator = line.alone ? `\n${line.before}` : " ";
  const insertAt = element.end + separator.length;
  return { text: text.slice(0, element.end) + separator + text.slice(element.start, element.end) + text.slice(element.end), insertAt };
}

function isBlank(node: SvgSourceNode) {
  return node.kind === "text" && !node.text.trim();
}

export function formatSvgSource(text: string): string | null {
  const document = parseSvgSource(text);
  if (!document.ok) return null;
  const raw = (start: number, end: number) => text.slice(start, end);
  const lines: string[] = [];
  const writeNode = (node: SvgSourceNode, depth: number) => {
    if (isBlank(node)) return;
    const indent = INDENT.repeat(depth);
    if (node.kind !== "element") {
      lines.push(indent + raw(node.start, node.end).trim());
      return;
    }
    const element = node.element;
    const attributes = element.attributes.map(attribute =>
      `${attribute.name}=${attribute.quote}${raw(attribute.valueStart, attribute.valueEnd)}${attribute.quote}`);
    const children = element.children.filter(child => !isBlank(child));
    const inline = children.length > 0 && children.every(child => child.kind === "text" || child.kind === "cdata");
    const close = children.length ? ">" : " />";
    const singleLine = `${indent}<${[element.name, ...attributes].join(" ")}${close}`;
    if (singleLine.length <= FORMAT_LINE_LIMIT || attributes.length < 2) lines.push(singleLine);
    else {
      lines.push(`${indent}<${element.name}`);
      attributes.forEach((attribute, index) =>
        lines.push(`${indent}${INDENT}${attribute}${index === attributes.length - 1 ? close.trimStart() : ""}`));
    }
    if (!children.length) return;
    if (inline) {
      lines[lines.length - 1] += children.map(child => child.kind === "element" ? "" : raw(child.start, child.end)).join("").trim()
        + `</${element.name}>`;
      return;
    }
    for (const child of children) writeNode(child, depth + 1);
    lines.push(`${indent}</${element.name}>`);
  };
  for (const node of document.prolog) writeNode(node, 0);
  writeNode({ kind: "element", element: document.root }, 0);
  for (const node of document.epilog) writeNode(node, 0);
  return `${lines.join("\n")}\n`;
}
