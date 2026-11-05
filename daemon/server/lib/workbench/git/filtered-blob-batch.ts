/*
 * Exports:
 * - FILTERED_BLOB_BATCH_ARGS: the `git cat-file` arguments this framing expects.
 * - FilteredBlob: a blob and the path whose attributes filter it.
 * - FilteredBlobBatch: one batch's stdin and the markers its output is cut at.
 * - planFilteredBlobBatch: build a batch's stdin, following every blob with a random never-existing object.
 * - parseFilteredBlobBatch: cut batch output at those markers into each path's filtered bytes.
 */
import { randomBytes } from "node:crypto";

export const FILTERED_BLOB_BATCH_ARGS = ["cat-file", "--batch", "--filters", "-Z"];

export interface FilteredBlob {
  id: string;
  path: string;
}

export interface FilteredBlobBatch {
  input: string;
  requests: ReadonlyArray<FilteredBlob & { marker: string }>;
}

export function planFilteredBlobBatch(blobs: readonly FilteredBlob[]): FilteredBlobBatch {
  const requests = blobs.map(blob => ({ ...blob, marker: randomBytes(20).toString("hex") }));
  return {
    input: requests.map(({ id, marker, path }) => `${id} ${path}\0${marker} marker\0`).join(""),
    requests,
  };
}

/**
 * Git's header reports a blob's size before filtering while its body is the filtered bytes, so sizes cannot frame the
 * output. Each body instead ends where its request's marker reports itself missing.
 */
export function parseFilteredBlobBatch(output: Buffer, { requests }: Pick<FilteredBlobBatch, "requests">) {
  const bytes = new Map<string, Buffer>();
  let offset = 0;
  for (const { id, marker, path } of requests) {
    const headerEnd = output.indexOf(0, offset);
    const header = headerEnd < 0 ? "" : output.toString("utf8", offset, headerEnd);
    if (!header.startsWith(`${id} blob `)) throw new Error(`Git has no filtered blob ${id} for ${path}.`);
    const terminator = Buffer.from(`\0${marker} missing\0`);
    const bodyEnd = output.indexOf(terminator, headerEnd + 1);
    if (bodyEnd < 0) throw new Error(`Git's filtered output for ${path} is truncated.`);
    bytes.set(path, output.subarray(headerEnd + 1, bodyEnd));
    offset = bodyEnd + terminator.length;
  }
  if (offset !== output.length) throw new Error("Git returned unexpected filtered output.");
  return bytes;
}
