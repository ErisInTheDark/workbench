/*
 * Exports:
 * - default BoundedShellOutput: what one command printed, keeping each stream's start and rolling end with a marked gap between, however much it prints.
 */
import type { WorkbenchShellPartialOutput } from "./workbench-shell-partial-output";

/** Test summaries and failures print last, and setup errors print first, so both ends earn an equal share. */
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 512 * 1024;
const GAP_MARKER = /\[Workbench omitted [\d,]+ bytes of this output; they were not saved\]/u;

/** Where the last complete UTF-8 character ends. */
function completeEnd(bytes: Buffer) {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** Where the first complete UTF-8 character starts. */
function completeStart(bytes: Buffer) {
  let start = 0;
  while (start < Math.min(3, bytes.length) && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

class BoundedStream {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  write(chunk: Buffer) {
    this.total += chunk.byteLength;
    const start = chunk.subarray(0, HEAD_BYTES - this.headBytes);
    if (start.byteLength) {
      this.head.push(start);
      this.headBytes += start.byteLength;
    }
    if (start.byteLength === chunk.byteLength) return;
    this.tail.push(chunk.subarray(start.byteLength));
    this.tailBytes += chunk.byteLength - start.byteLength;
    while (this.tailBytes - this.tail[0]!.byteLength >= TAIL_BYTES) this.tailBytes -= this.tail.shift()!.byteLength;
  }

  read() {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (this.total <= HEAD_BYTES + TAIL_BYTES) return Buffer.concat([head, tail]).toString("utf8");
    const kept = tail.subarray(tail.byteLength - TAIL_BYTES);
    const end = head.subarray(0, completeEnd(head));
    const rest = kept.subarray(completeStart(kept));
    const omitted = (this.total - end.byteLength - rest.byteLength).toLocaleString("en-US");
    return `${end.toString("utf8")}\n[Workbench omitted ${omitted} bytes of this output; they were not saved]\n${rest.toString("utf8")}`;
  }
}

export default class BoundedShellOutput {
  /** Whether text carries a gap from a command that printed too much, so no saved copy of it can be complete. */
  static hasGap(text: string) {
    return GAP_MARKER.test(text);
  }

  private readonly streams = { stderr: new BoundedStream(), stdout: new BoundedStream() };

  write(stream: "stdout" | "stderr", chunk: Buffer) {
    this.streams[stream].write(chunk);
  }

  read(): WorkbenchShellPartialOutput {
    return { stderr: this.streams.stderr.read(), stdout: this.streams.stdout.read() };
  }
}
