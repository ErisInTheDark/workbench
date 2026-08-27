/*
 * Exports:
 * - WorkbenchTagWrapperValue/WorkbenchTagWrapper/DefineTagWrapperOptions: typed tag-wrapper values, operations, and definition options. Keywords: workbench, tag, wrapper, parse.
 * - defineTagWrapper: define one deterministic wb-prefixed wrapper with ordered escaped attributes. Keywords: workbench, tag, wrap, unwrap.
 */

export interface WorkbenchTagWrapperValue<AttributeName extends string> {
  attributes: Record<AttributeName, string>;
  body: string;
}

export interface WorkbenchTagWrapper<AttributeName extends string> {
  readonly tagName: string;
  read(value: string): WorkbenchTagWrapperValue<AttributeName> | null;
  unwrap(value: string): string;
  wrap(body: string, attributes: Record<AttributeName, string>): string;
}

export interface DefineTagWrapperOptions<AttributeName extends string> {
  allowLeadingText?: boolean;
  attributes: readonly AttributeName[];
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function escapeAttributeValue(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/\r/gu, "&#13;")
    .replace(/\n/gu, "&#10;")
    .replace(/\t/gu, "&#9;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function unescapeAttributeValue(value: string) {
  return value
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&quot;/gu, "\"")
    .replace(/&#9;/gu, "\t")
    .replace(/&#10;/gu, "\n")
    .replace(/&#13;/gu, "\r")
    .replace(/&amp;/gu, "&");
}

export function defineTagWrapper<const AttributeName extends string>(
  tagName: string,
  {
    allowLeadingText = false,
    attributes,
  }: DefineTagWrapperOptions<AttributeName>,
): WorkbenchTagWrapper<AttributeName> {
  if (!/^wb(?::[a-z][a-z0-9-]*)+$/u.test(tagName)) {
    throw new Error("Workbench agent-facing tag names must use the wb: prefix.");
  }
  if (new Set(attributes).size !== attributes.length || attributes.some((name) => !/^[a-z][a-z0-9-]*$/u.test(name))) {
    throw new Error("Workbench tag attributes must be unique lowercase names.");
  }

  const openingPattern = new RegExp(
    `^<${escapeRegularExpression(tagName)}${attributes.map((name) => ` ${escapeRegularExpression(name)}="([^"]*)"`).join("")}>$`,
    "u",
  );
  const closingTag = `</${tagName}>`;

  const read = (value: string): WorkbenchTagWrapperValue<AttributeName> | null => {
    const lines = value.replace(/\r\n?/gu, "\n").trim().split("\n");
    if (lines.at(-1) !== closingTag) return null;
    const openingIndex = allowLeadingText
      ? lines.findIndex((line) => openingPattern.test(line))
      : openingPattern.test(lines[0] ?? "") ? 0 : -1;
    if (openingIndex < 0 || openingIndex >= lines.length - 1) return null;
    const openingMatch = openingPattern.exec(lines[openingIndex] ?? "");
    if (!openingMatch) return null;

    const parsedAttributes = Object.fromEntries(attributes.map((name, index) => [
      name,
      unescapeAttributeValue(openingMatch[index + 1] ?? ""),
    ])) as Record<AttributeName, string>;
    return {
      attributes: parsedAttributes,
      body: lines.slice(openingIndex + 1, -1).join("\n").trim(),
    };
  };

  return {
    tagName,
    read,
    unwrap(value) {
      return read(value)?.body ?? value;
    },
    wrap(body, values) {
      const openingTag = `<${tagName}${attributes.map((name) => ` ${name}="${escapeAttributeValue(values[name])}"`).join("")}>`;
      return `${openingTag}\n${body}\n${closingTag}`;
    },
  };
}
