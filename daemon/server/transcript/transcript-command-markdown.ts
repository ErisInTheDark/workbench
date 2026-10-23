/*
 * Exports:
 * - transcriptCommand: build native-shell commands from validated query selections.
 * - transcriptPageOutput: attach exact continuation commands to bounded item data.
 * - renderTranscriptPage: render compact grouped item data, search evidence and incomplete-storage warnings.
 */
import path from "node:path";
import type { HistoryField, HistoryPage, HistoryQuery } from "../database/history/history-query-contract";
import { TRANSCRIPT_PREVIEW_CHAR_LIMIT } from "../database/history/history-item-fields";

function quote(value: string) {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

export function transcriptCommand(query: HistoryQuery) {
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
  value("--query", query.query);
  if (query.opaque) args.push("--opaque");
  value("--item", query.item);
  value("--before", query.before);
  value("--after", query.after);
  value("--around", query.around);
  if (query.around) value("--context", query.context);
  value("--limit", query.limit);
  value("--cursor", query.cursor);
  if (query.json) args.push("--json");
  return args.join(" ");
}

export function transcriptPageOutput(query: HistoryQuery, page: HistoryPage) {
  const anchors = { before: null, after: null, around: null, cursor: null };
  const first = page.rows[0]?.id;
  const last = page.rows.at(-1)?.id;
  return {
    ...page,
    nextCommand: page.nextCursor ? transcriptCommand({ ...query, cursor: page.nextCursor }) : null,
    olderCommand: query.action === "read" && page.older && first ? transcriptCommand({ ...query, ...anchors, before: first }) : null,
    newerCommand: query.action === "read" && page.newer && last ? transcriptCommand({ ...query, ...anchors, after: last }) : null,
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

function fieldLines(field: HistoryField, preview: boolean, cwd?: string) {
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

function renderFields(fields: HistoryField[], preview: boolean, cwd?: string) {
  const lines: string[] = [];
  let previous: HistoryField["path"] = [];
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

function searchLines(page: HistoryPage) {
  const summary = page.search;
  if (!summary) return [];
  return [
    `matches: ${summary.complete} with every term, ${summary.partial} with some; best first`,
    `terms: ${summary.terms.map(term => `${term.term} ${term.hits}`).join(" · ")}`,
    ...(summary.indexed < 1 ? [`index still building (${Math.floor(summary.indexed * 100)}%); some older items are not searchable yet`] : []),
    ...summary.corrections.map(correction => `searched ${JSON.stringify(correction.to)} for ${JSON.stringify(correction.from)}, which matched nothing`),
  ];
}

export function renderTranscriptPage(query: HistoryQuery, page: HistoryPage, cwd?: string) {
  const output = transcriptPageOutput(query, page);
  const lines: string[] = [];
  let thread: string | null = null;
  let turn: string | null = null;
  // Ranked search results jump between threads and turns; only chronological pages group by them.
  const grouped = query.action !== "search";
  const preview = query.action !== "show";
  if (page.coverage.materializedTurns < page.coverage.turns) {
    lines.push(`incomplete storage: ${page.coverage.materializedTurns}/${page.coverage.turns} turns materialised`);
  }
  if (page.coverage.expiredTurns) {
    lines.push(`expired storage: ${page.coverage.expiredTurns}/${page.coverage.turns} turn payloads removed by retention; `
      + "--provider with exactly one --thread and --turn recovers that turn until the next retention run");
  }
  if (page.gaps.length) lines.push(`unmaterialised turns in this window: ${page.gaps.join(", ")}`);
  if (page.expired.length) lines.push(`retention-expired turns in this window: ${page.expired.join(", ")}`);
  lines.push(...searchLines(page));
  if (output.olderCommand) lines.push("", `older: ${output.olderCommand}`);
  if (!page.rows.length) lines.push("no matches");
  for (const row of output.rows) {
    const item = row.turnId !== null && row.kind !== "turn";
    if (grouped && (item || row.kind === "turn")) {
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
    if (!grouped && item) lines.push(`  thread: ${row.threadId}`, `  turn: ${row.turnId}`);
    if (!item && row.projectId && row.kind !== "project") lines.push(`  project: ${row.projectId}`);
    if (!item && row.createdAt !== null) lines.push(`  time: ${new Date(row.createdAt).toISOString()}`);
    for (const [key, count] of Object.entries(row.counts)) lines.push(`  ${key}: ${count}`);
    if (row.excerpt) lines.push(`  match: ${row.excerpt}`);
    lines.push(...renderFields(row.fields, preview, cwd));
  }
  if (output.newerCommand) lines.push("", `newer: ${output.newerCommand}`);
  if (output.nextCommand) lines.push("", output.nextCommand);
  return `${lines.join("\n").trimStart()}\n`;
}
