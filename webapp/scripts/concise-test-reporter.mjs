/*
 * Default export:
 * - conciseTestReporter: renders failures, bounded process noise, slow tests, and one final summary without pass-by-pass TAP chatter. Keywords: tests, reporter, failures, stderr, slow, summary.
 */
import { inspect } from "node:util";

const FAILURE_ENTRY_LIMIT = 6_000;
const FAILURE_TOTAL_LIMIT = 16_000;
const NOISE_ENTRY_LIMIT = 4_000;
const NOISE_TOTAL_LIMIT = 16_000;
const SLOW_TEST_LIMIT = 20;
const SLOW_TEST_THRESHOLD_MS = 1_000;

function duration(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function location(data) {
  return typeof data?.file === "string" ? data.file : "unknown file";
}

function testName(data) {
  return typeof data?.name === "string" ? data.name : "unnamed test";
}

function errorText(data) {
  const error = data?.details?.error ?? data?.error;
  if (error instanceof Error) return error.stack ?? error.message;
  return typeof error === "string" ? error : inspect(error, { colors: false, depth: 6 });
}

function boundedNoise(message, remaining) {
  const text = String(message ?? "").trimEnd();
  const limit = Math.max(0, Math.min(NOISE_ENTRY_LIMIT, remaining));
  if (text.length <= limit) return { omitted: 0, text };
  return { omitted: text.length - limit, text: text.slice(0, limit) };
}

function boundedFailure(message, remaining) {
  const text = String(message ?? "").trimEnd();
  const limit = Math.max(0, Math.min(FAILURE_ENTRY_LIMIT, remaining));
  if (text.length <= limit) return { omitted: 0, text };
  if (limit === 0) return { omitted: text.length, text: "" };
  const headLength = Math.ceil(limit * 0.75);
  const tailLength = limit - headLength;
  return {
    omitted: text.length - limit,
    text: tailLength > 0 ? `${text.slice(0, headLength)}\n...\n${text.slice(-tailLength)}` : text.slice(0, headLength),
  };
}

function summaryLine(counts, elapsedMs) {
  return `Tests: ${counts.tests} | Pass: ${counts.pass} | Fail: ${counts.fail} | Skip: ${counts.skip} | Duration: ${elapsedMs.toFixed(1)}ms`;
}

export default async function* conciseTestReporter(source) {
  const startedAt = performance.now();
  const activeByFile = new Map();
  const failures = [];
  const noise = [];
  const slow = [];
  const counts = { fail: 0, pass: 0, skip: 0, tests: 0 };
  let failureCharacters = 0;
  let omittedNoiseCharacters = 0;
  let omittedNoiseEntries = 0;
  let noiseCharacters = 0;

  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:start") activeByFile.set(location(data), testName(data));
    if (event.type === "test:pass" || event.type === "test:fail") {
      counts.tests += 1;
      const elapsed = duration(data.details?.duration_ms ?? data.duration_ms);
      if (elapsed >= SLOW_TEST_THRESHOLD_MS) slow.push({ elapsed, file: location(data), name: testName(data) });
      if (event.type === "test:fail") {
        counts.fail += 1;
        const bounded = boundedFailure(errorText(data), FAILURE_TOTAL_LIMIT - failureCharacters);
        failureCharacters += bounded.text.length;
        failures.push({ elapsed, error: bounded.text, file: location(data), name: testName(data), omitted: bounded.omitted });
      } else if (data.skip !== undefined || data.todo !== undefined) counts.skip += 1;
      else counts.pass += 1;
      if (activeByFile.get(location(data)) === testName(data)) activeByFile.delete(location(data));
    }
    if (event.type === "test:stdout" || event.type === "test:stderr") {
      const file = location(data);
      const remaining = NOISE_TOTAL_LIMIT - noiseCharacters;
      if (remaining <= 0) {
        omittedNoiseCharacters += String(data.message ?? "").trimEnd().length;
        omittedNoiseEntries += 1;
        continue;
      }
      const bounded = boundedNoise(data.message, remaining);
      noiseCharacters += bounded.text.length;
      if (bounded.text || bounded.omitted > 0) noise.push({
        file,
        message: bounded.text,
        omitted: bounded.omitted,
        stream: event.type === "test:stderr" ? "stderr" : "stdout",
        test: typeof data.name === "string" ? data.name : activeByFile.get(file),
      });
    }
  }

  if (failures.length > 0) {
    yield `\nFAILURES (${failures.length})\n`;
    for (const failure of failures) {
      const truncation = failure.omitted > 0 ? `\n[truncated ${failure.omitted} failure characters]` : "";
      yield `FAIL ${failure.file} :: ${failure.name} (${failure.elapsed.toFixed(1)}ms)\n${failure.error}${truncation}\n`;
    }
    if (failureCharacters >= FAILURE_TOTAL_LIMIT) yield `[additional failure details omitted after ${FAILURE_TOTAL_LIMIT} characters]\n`;
  }
  if (noise.length > 0) {
    yield `\nNOISE (${noise.length})\n`;
    for (const entry of noise) {
      const owner = entry.test ? ` :: ${entry.test}` : "";
      const truncation = entry.omitted > 0 ? `\n[truncated ${entry.omitted} characters]` : "";
      yield `${entry.stream.toUpperCase()} ${entry.file}${owner}\n${entry.message}${truncation}\n`;
    }
    if (omittedNoiseEntries > 0) {
      yield `[omitted ${omittedNoiseEntries} additional noise ${omittedNoiseEntries === 1 ? "entry" : "entries"} totaling ${omittedNoiseCharacters} characters after ${NOISE_TOTAL_LIMIT} retained characters]\n`;
    }
  }
  const selectedSlow = slow.sort((left, right) => right.elapsed - left.elapsed).slice(0, SLOW_TEST_LIMIT);
  if (selectedSlow.length > 0) {
    yield `\nSLOW TESTS >= ${SLOW_TEST_THRESHOLD_MS}ms (top ${selectedSlow.length})\n`;
    for (const entry of selectedSlow) yield `${entry.elapsed.toFixed(1)}ms ${entry.file} :: ${entry.name}\n`;
  }
  yield `\n${summaryLine(counts, performance.now() - startedAt)}\n`;
}
