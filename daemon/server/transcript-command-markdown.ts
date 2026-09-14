/*
 * Exports:
 * - transcriptCommand: build native-shell commands from validated query selections.
 * - transcriptPageOutput: attach one continuation to bounded item data.
 * - renderTranscriptPage: render compact grouped item data and incomplete-storage warnings.
 */
import path from "node:path";
import type { TranscriptField, TranscriptQuery, TranscriptQueryPage } from "./database/transcript/transcript-query-contract";
import { TRANSCRIPT_PREVIEW_CHAR_LIMIT } from "./database/transcript/transcript-item-data";

function quote(value: string) {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

export function transcriptCommand(query: TranscriptQuery) {
  const args = ["wb", "transcript", query.action];
  const value = (flag: string, input: string | number | boolean | null) => { if (input !== null) args.push(flag, quote(String(input))); };
  query.threads.forEach(id => value("--thread", id));
  value("--project", query.project);
  value("--harness", query.harness);
  value("--turn", query.turn);
  query.kinds.forEach(kind => value("--kind", kind));
  value("--phase", query.phase);
  value("--tool", query.tool);
  value("--file", query.file);
  value("--since", query.since);
  value("--until", query.until);
  value("--archived", query.archived);
  value("--settled", query.settled);
  query.queries.forEach(text => value("--query", text));
  query.excludes.forEach(text => value("--exclude", text));
  if (query.any) args.push("--any");
  if (query.caseSensitive) args.push("--case-sensitive");
  if (query.opaque) args.push("--opaque");
  value("--item", query.item);
  value("--around", query.around);
  if (query.around) value("--context", query.context);
  value("--limit", query.limit);
  if (["read", "turns", "search"].includes(query.action)) value("--direction", query.direction);
  value("--cursor", query.cursor);
  if (query.json) args.push("--json");
  return args.join(" ");
}

export function transcriptPageOutput(query: TranscriptQuery, page: TranscriptQueryPage) {
  return {
    ...page,
    nextCommand: page.nextCursor ? transcriptCommand({ ...query, cursor: page.nextCursor }) : null,
  };
}

function label(value: string | number) {
  return typeof value === "number" ? `[${value}]` : /^[A-Za-z_$][\w$]*$/u.test(value) ? value : JSON.stringify(value);
}

function sameDirectory(value: string, cwd: string) {
  // Relative item directories have no known base. Never resolve them against this server's cwd.
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(cwd);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(value) || !paths.isAbsolute(cwd)) return false;
  const normalise = (input: string) => {
    const normalized = paths.normalize(input);
    const root = paths.parse(normalized).root;
    const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/u, "") : normalized;
    return windows ? trimmed.toLowerCase() : trimmed;
  };
  return normalise(value) === normalise(cwd);
}

function fieldLines(field: TranscriptField, preview: boolean, cwd?: string) {
  let value = field.value;
  let trimmed = field.length !== undefined && (field.offset ?? 0) + Array.from(String(value)).length < field.length;
  if (typeof value === "string" && field.path.at(-1) === "cwd") {
    if (!field.offset && !trimmed && cwd && sameDirectory(value, cwd)) value = ".";
    else if (preview && Array.from(value).length > TRANSCRIPT_PREVIEW_CHAR_LIMIT) {
      value = Array.from(value).slice(0, TRANSCRIPT_PREVIEW_CHAR_LIMIT).join("");
      trimmed = true;
    }
  }
  const suffix = `${field.offset ? ` [offset ${field.offset}]` : ""}${trimmed ? " [trimmed]" : ""}`;
  if (typeof value !== "string") return [`${JSON.stringify(value)}${suffix}`];
  if (value.includes("\n") || value.includes("\r")) {
    return [`|${suffix}`, ...value.replace(/\r\n?/gu, "\n").split("\n").map(line => `  ${line}`)];
  }
  // Quote only ambiguous scalars, retaining the distinction from null, booleans and numbers.
  const scalar = !value || value.trim() !== value || /^(?:null|true|false|[-+]?\d|[{}\[\]"'|])/u.test(value)
    ? JSON.stringify(value) : value;
  return [`${scalar}${suffix}`];
}

function renderFields(fields: TranscriptField[], preview: boolean, cwd?: string) {
  const lines: string[] = [];
  let previous: TranscriptField["path"] = [];
  for (const field of fields) {
    if (preview && (field.value === null || typeof field.value === "object")) continue;
    const parents = field.path.slice(0, -1);
    let shared = 0;
    while (shared < parents.length && shared < previous.length && parents[shared] === previous[shared]) shared++;
    for (let index = shared; index < parents.length; index++) {
      lines.push(`${"  ".repeat(index + 1)}${label(parents[index]!)}:`);
    }
    const depth = "  ".repeat(field.path.length);
    const [first, ...rest] = fieldLines(field, preview, cwd);
    lines.push(`${depth}${label(field.path.at(-1)!)}: ${first}`, ...rest.map(line => `${depth}${line}`));
    previous = parents;
  }
  return lines;
}

export function renderTranscriptPage(query: TranscriptQuery, page: TranscriptQueryPage, cwd?: string) {
  const output = transcriptPageOutput(query, page);
  const lines: string[] = [];
  let thread: string | null = null;
  let turn: string | null = null;
  const preview = query.action !== "show";
  if (page.coverage.materializedTurns < page.coverage.turns) {
    lines.push(`incomplete storage: ${page.coverage.materializedTurns}/${page.coverage.turns} turns materialised`);
  }
  if (!page.rows.length) lines.push("no matches");
  for (const row of output.rows) {
    const item = row.turnId !== null && row.kind !== "turn";
    if (item || row.kind === "turn") {
      if (row.threadId !== thread) {
        lines.push(`thread ${row.threadId}`);
        thread = row.threadId;
        turn = null;
      }
      if (item && row.turnId !== turn) {
        lines.push(`turn ${row.turnId}`);
        turn = row.turnId;
      }
    }
    lines.push("", `${row.kind} ${row.id}${!item && row.title ? ` ${JSON.stringify(row.title)}` : ""}`);
    if (!item && row.projectId && row.kind !== "project") lines.push(`  project: ${row.projectId}`);
    if (!item && row.createdAt !== null) lines.push(`  time: ${new Date(row.createdAt).toISOString()}`);
    for (const [key, count] of Object.entries(row.counts)) lines.push(`  ${key}: ${count}`);
    lines.push(...renderFields(row.fields, preview, cwd));
  }
  if (output.nextCommand) lines.push("", output.nextCommand);
  return `${lines.join("\n").trimStart()}\n`;
}
