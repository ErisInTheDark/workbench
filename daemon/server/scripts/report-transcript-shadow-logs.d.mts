/*
 * Exports: types for ./report-transcript-shadow-logs.mjs, a standalone log report script.
 * - TranscriptShadowRecord/TranscriptShadowGroup/TranscriptShadowReportOptions: one log line, its repeat group, and filters.
 * - formatAgentValue/formatTranscriptShadowFields/readTranscriptShadowReport.
 */
export interface TranscriptShadowRecord {
  at: number;
  event: string;
  fields?: Record<string, unknown>;
  level: string;
  source: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface TranscriptShadowGroup {
  count: number;
  firstAt: number;
  lastAt: number;
  record: TranscriptShadowRecord;
  signature: string;
}

export interface TranscriptShadowReportOptions {
  all?: boolean;
  events?: readonly string[];
  limit?: number;
  since?: number | null;
  sources?: readonly string[];
  threadId?: string | null;
}

export function formatAgentValue(value: unknown): string[];
export function formatTranscriptShadowFields(fields: unknown, options?: { details?: boolean }): string[];
export function readTranscriptShadowReport(filePath: string, options?: TranscriptShadowReportOptions): Promise<TranscriptShadowGroup[]>;
