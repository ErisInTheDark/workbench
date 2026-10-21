/*
 * Exports:
 * - formatMcpInputSchema: agent-facing text for a tool input schema; a TypeScript-like type, or exact JSON when the schema uses keywords the type cannot show.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | Schema;
interface Schema { [key: string]: JsonValue }

/** Keywords the rendered type or its trailing note carries. */
const RENDERED = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "description",
  "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern",
  "minItems", "maxItems", "uniqueItems", "format", "propertyNames",
]);
/** Annotations that change no accepted input. */
const IGNORED = new Set(["$schema", "$id", "$comment", "title", "examples", "deprecated", "readOnly", "writeOnly"]);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

class UnsupportedSchema extends Error {}

function isSchema(value: JsonValue | undefined): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaAt(value: JsonValue | undefined) {
  if (!isSchema(value)) throw new UnsupportedSchema();
  for (const key of Object.keys(value)) if (!RENDERED.has(key) && !IGNORED.has(key)) throw new UnsupportedSchema();
  return value;
}

/** Safe-integer bounds only restate the number type, so they are left out. */
function numeric(value: JsonValue | undefined) {
  return typeof value === "number" && Math.abs(value) !== Number.MAX_SAFE_INTEGER ? value : null;
}

function range(min: number | null, max: number | null, unit: string) {
  if (unit && min === 1 && max === null) return "non-empty";
  if (min !== null && max !== null) return `${min}-${max}${unit}`;
  if (min !== null) return `min ${min}${unit}`;
  return max !== null ? `max ${max}${unit}` : null;
}

/** Constraints a type cannot express, from this schema, its union members and its array element. */
function constraints(schema: Schema): string[] {
  const notes: string[] = [];
  if (schema.type === "integer") notes.push("int");
  const above = numeric(schema.exclusiveMinimum);
  const below = numeric(schema.exclusiveMaximum);
  if (above !== null) notes.push(`> ${above}`);
  if (below !== null) notes.push(`< ${below}`);
  for (const note of [
    range(numeric(schema.minimum), numeric(schema.maximum), ""),
    range(numeric(schema.minLength), numeric(schema.maxLength), " chars"),
    range(numeric(schema.minItems), numeric(schema.maxItems), " items"),
  ]) if (note) notes.push(note);
  if (schema.uniqueItems === true) notes.push("unique");
  if (typeof schema.pattern === "string") notes.push(`pattern ${schema.pattern}`);
  if (typeof schema.format === "string") notes.push(`format ${schema.format}`);
  for (const members of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(members)) for (const member of members) notes.push(...constraints(schemaAt(member)));
  }
  if (isSchema(schema.items)) notes.push(...constraints(schemaAt(schema.items)));
  return [...new Set(notes)];
}

function trailingNote(schema: Schema) {
  const parts = [
    typeof schema.description === "string" ? schema.description.replace(/\s+/gu, " ").trim().replace(/\.$/u, "") : "",
    ...constraints(schema),
    ...schema.default !== undefined ? [`default ${JSON.stringify(schema.default)}`] : [],
  ].filter(Boolean);
  return parts.length ? ` // ${parts.join(", ")}` : "";
}

function union(types: string[]) {
  return [...new Set(types)].join(" | ");
}

function primitive(type: JsonValue, schema: Schema, indent: string): string {
  switch (type) {
    case "string":
    case "boolean":
    case "null": return type;
    case "number":
    case "integer": return "number";
    case "array": {
      if (schema.items === undefined) return "unknown[]";
      const element = render(schemaAt(schema.items), indent);
      return element.includes(" | ") ? `(${element})[]` : `${element}[]`;
    }
    case "object": return object(schema, indent);
    default: throw new UnsupportedSchema();
  }
}

/** Fields print one per line without separators; that saves tokens and still reads as TypeScript. */
function object(schema: Schema, indent: string) {
  const properties = schema.properties;
  const extra = schema.additionalProperties;
  if (properties === undefined || (isSchema(properties) && !Object.keys(properties).length)) {
    return isSchema(extra) ? `{ [key: string]: ${render(schemaAt(extra), indent)} }` : "{}";
  }
  if (!isSchema(properties) || isSchema(extra)) throw new UnsupportedSchema();
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const inner = `${indent}  `;
  const lines = Object.entries(properties).map(([name, value]) => {
    const property = schemaAt(value);
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    return `${inner}${key}${required.has(name) ? "" : "?"}: ${render(property, inner)}${trailingNote(property)}`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function render(schema: Schema, indent: string): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(value => JSON.stringify(value)));
  const members = schema.anyOf ?? schema.oneOf;
  if (members !== undefined) {
    if (!Array.isArray(members) || schema.type !== undefined) throw new UnsupportedSchema();
    return union(members.map(member => render(schemaAt(member), indent)));
  }
  const type = schema.type;
  if (type === undefined) return schema.properties !== undefined ? object(schema, indent) : "unknown";
  return Array.isArray(type) ? union(type.map(member => primitive(member, schema, indent))) : primitive(type, schema, indent);
}

export function formatMcpInputSchema(schema: object) {
  const json = JSON.stringify(schema);
  try {
    // Parsing the serialised schema yields plain JSON, whatever object type the caller held.
    return `Input: ${render(schemaAt(JSON.parse(json) as JsonValue), "")}`;
  } catch (error) {
    if (!(error instanceof UnsupportedSchema)) throw error;
    return `Input schema: ${json}`;
  }
}
