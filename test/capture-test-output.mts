/*
 * captureTestOutput: collect explicitly expected writes within one test, forwarding all other output.
 */
import type { TestContext } from "node:test";

export function captureTestOutput(
  context: TestContext,
  stream: Pick<NodeJS.WritableStream, "write">,
  accepts: (text: string) => boolean,
) {
  const records: string[] = [];
  const original = stream.write;
  context.mock.method(stream, "write", function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (!accepts(text)) return Reflect.apply(original, stream, arguments);
    records.push(text);
    const completed = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (completed) queueMicrotask(() => completed(null));
    return true;
  });
  return records;
}
