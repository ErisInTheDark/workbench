/*
 * Exports:
 * - transcriptItemFields: traverse canonical item data with CLI disclosure rules.
 * - previewTranscriptFields: abbreviate string content without dropping populated fields.
 * - expandTranscriptFields: page complete values without splitting Unicode code points.
 * - TRANSCRIPT_PREVIEW_CHAR_LIMIT: shared preview limit, including deferred cwd rendering.
 */
import type { WorkbenchProjectedTranscriptItem } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import type { TranscriptField } from "./transcript-query-contract";

type Data = object | string | number | boolean | null | undefined;
export const TRANSCRIPT_PREVIEW_CHAR_LIMIT = 120;

export function transcriptItemFields(item: WorkbenchProjectedTranscriptItem, opaque: boolean): TranscriptField[] {
  const fields: TranscriptField[] = [];
  const secrets = item.type === "questionnaire" || item.type === "approval"
    ? new Set(item.request.questions.filter(question => question.isSecret).map(question => question.id))
    : new Set<string>();
  const visit = (value: Data, path: TranscriptField["path"]) => {
    if (value === undefined) return;
    if (path.length === 1 && (path[0] === "id" || path[0] === "type")) return;
    if (path[0] === "response" && path[1] === "answers" && typeof path[2] === "string"
      && secrets.has(path[2]) && path[3] === "answers") {
      // Redact the entire answer array before visiting any of its values.
      fields.push({ path, value: "[redacted]" });
      return;
    }
    if (!opaque && (
      (item.type === "generic" && path[0] === "safeValue")
      || (item.type === "webSearch" && path[0] === "results")
      || (item.type === "mcpToolCall" && path[0] === "result" && (
        path[1] === "_meta"
        || (path[1] === "content" && path.length === 3 && value !== null && typeof value === "object"
          && (!("type" in value) || value.type !== "text"))
      ))
    )) {
      if (value !== null) fields.push({ path, value: "[opaque; use --opaque]" });
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries: [string, Data][] = Object.entries(value);
      if (!entries.length) fields.push({ path, value: Array.isArray(value) ? [] : {} });
      else for (const [key, child] of entries) visit(child, [...path, Array.isArray(value) ? Number(key) : key]);
      return;
    }
    if (value === null) fields.push({ path, value: null });
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields.push({
        path,
        value: typeof value === "string" && /^data:[^,]*;base64,/u.test(value) ? "[inline asset omitted]" : value,
      });
    }
  };
  visit(item, []);
  return fields;
}

export function previewTranscriptFields(fields: TranscriptField[]): TranscriptField[] {
  return fields.flatMap(field => {
    if (field.value === null || typeof field.value === "object") return [];
    // Keep cwd intact until the renderer can compare it with the caller's cwd.
    if (typeof field.value !== "string" || field.path.at(-1) === "cwd") return [field];
    const points = Array.from(field.value);
    return [points.length > TRANSCRIPT_PREVIEW_CHAR_LIMIT
      ? { ...field, value: points.slice(0, TRANSCRIPT_PREVIEW_CHAR_LIMIT).join(""), offset: 0, length: points.length }
      : field];
  });
}

export function expandTranscriptFields(
  fields: TranscriptField[],
  index = 0,
  offset = 0,
): { fields: TranscriptField[]; next: { index: number; offset: number } | null } {
  const page: TranscriptField[] = [];
  let budget = 12000;
  for (; index < fields.length; index++) {
    const field = fields[index]!;
    if (typeof field.value !== "string") {
      page.push(field);
      budget -= String(field.value).length;
    } else {
      const points = Array.from(field.value);
      const end = Math.min(points.length, offset + Math.max(1, budget));
      page.push(offset || end < points.length
        ? { ...field, value: points.slice(offset, end).join(""), offset, length: points.length }
        : field);
      budget -= end - offset;
      if (end < points.length) return { fields: page, next: { index, offset: end } };
    }
    offset = 0;
    if ((budget <= 0 || page.length === 50) && index + 1 < fields.length) {
      return { fields: page, next: { index: index + 1, offset: 0 } };
    }
  }
  return { fields: page, next: null };
}
