/*
 * formatAgentValue: render JSON-like diagnostics with minimal repeated syntax. Keywords: transcript, shadow, log, agent, format.
 * readTranscriptShadowReport: filter and group the dedicated transcript-shadow JSONL. Keywords: transcript, shadow, log, report.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMIT = 100;

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "string") return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  return String(value);
}

function isScalar(value) {
  return value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function indent(lines, depth = 1) {
  const prefix = "  ".repeat(depth);
  return lines.map((line) => `${prefix}${line}`);
}

export function formatAgentValue(value) {
  if (isScalar(value)) return [scalar(value)];
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return [value.map(scalar).join(" ")];
    const objects = value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    const keys = objects.length === value.length && objects.length
      ? Object.keys(objects[0])
      : [];
    const tabular = keys.length
      && objects.every((entry) => (
        Object.keys(entry).join("\0") === keys.join("\0")
        && keys.every((key) => isScalar(entry[key]))
      ));
    if (tabular) {
      return [
        keys.join("\t"),
        ...objects.map((entry) => keys.map((key) => scalar(entry[key])).join("\t")),
      ];
    }
    return value.flatMap((entry, index) => [
      String(index),
      ...indent(formatAgentValue(entry)),
    ]);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) => (
      isScalar(nested) || (Array.isArray(nested) && nested.every(isScalar))
        ? [`${key} ${formatAgentValue(nested)[0]}`]
        : [key, ...indent(formatAgentValue(nested))]
    ));
  }
  return [String(value)];
}

function parseSince(value, now = new Date()) {
  if (!value) return null;
  if (/^\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/u.test(value)) {
    const [hours, minutes, secondsAndMilliseconds] = value.split(":");
    const [seconds, milliseconds = "0"] = secondsAndMilliseconds.split(".");
    const date = new Date(now);
    date.setHours(Number(hours), Number(minutes), Number(seconds), Number(milliseconds));
    return date.getTime();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --since value: ${value}`);
  return parsed;
}

function parseArgs(args) {
  const result = { all: false, limit: DEFAULT_LIMIT, since: null, threadId: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--all") {
      result.all = true;
    } else if (argument === "--since" && value) {
      result.since = parseSince(value);
      index += 1;
    } else if (argument === "--thread" && value) {
      result.threadId = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return result;
}

export async function readTranscriptShadowReport(filePath, options = {}) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  const records = source.split(/\r?\n/u).filter(Boolean).flatMap((line, lineIndex) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value)
        ? [value]
        : [{ at: 0, event: "malformed-line", fields: { line: lineIndex + 1 }, level: "error", source: "report" }];
    } catch {
      return [{ at: 0, event: "malformed-line", fields: { line: lineIndex + 1 }, level: "error", source: "report" }];
    }
  }).filter((record) => (
    (options.since === null || options.since === undefined || record.at >= options.since)
    && (!options.threadId || record.threadId === options.threadId)
    && (options.all || record.level === "error" || record.level === "warning")
  ));

  const groupedBySignature = new Map();
  for (const record of records) {
    const signature = record.event === "parity-mismatch"
      ? JSON.stringify({
        event: record.event,
        level: record.level,
        mismatch: record.fields?.mismatch,
        scope: record.fields?.scope,
        source: record.source,
        threadId: record.threadId,
      })
      : JSON.stringify({ ...record, at: undefined });
    const group = groupedBySignature.get(signature);
    if (group) {
      group.count += 1;
      group.lastAt = record.at;
      group.record = record;
    } else {
      groupedBySignature.set(signature, {
        count: 1,
        firstAt: record.at,
        lastAt: record.at,
        record,
        signature,
      });
    }
  }
  return [...groupedBySignature.values()]
    .sort((left, right) => left.lastAt - right.lastAt)
    .slice(-Math.max(1, options.limit ?? DEFAULT_LIMIT));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(process.cwd(), "..", ".workbench", "logs", "workbench-transcript-shadow.jsonl");
  const groups = await readTranscriptShadowReport(filePath, options);
  const output = groups.flatMap(({ count, firstAt, lastAt, record }) => {
    const { event, fields, level, source, threadId } = record;
    return [
      ...(count > 1
        ? [`first ${new Date(firstAt).toISOString()}`, `last ${new Date(lastAt).toISOString()}`]
        : [`at ${new Date(firstAt).toISOString()}`]),
      `source ${source}`,
      `level ${level}`,
      `event ${event}`,
      ...(threadId ? [`threadId ${threadId}`] : []),
      ...(count > 1 ? [`count ${count}`] : []),
      ...(fields ? formatAgentValue(fields) : []),
      "",
    ];
  });
  process.stdout.write(output.length ? `${output.join("\n")}\n` : "no transcript shadow records\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
