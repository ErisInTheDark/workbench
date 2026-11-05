/*
 * No production exports. Tests cover cutting filtered batch output at markers whatever its bodies contain, and refusing
 * output that does not account for every request.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseFilteredBlobBatch, planFilteredBlobBatch, type FilteredBlobBatch } from "./filtered-blob-batch";

const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);
const blobs = [{ id: ID_A, path: "a b.txt" }, { id: ID_B, path: "b.bin" }];

function respond({ requests }: FilteredBlobBatch, bodies: readonly Buffer[]) {
  return Buffer.concat(requests.flatMap(({ id, marker }, index) => [
    Buffer.from(`${id} blob 999\0`), bodies[index]!, Buffer.from(`\0${marker} missing\0`),
  ]));
}

test("bodies are recovered exactly, whatever they contain", () => {
  const batch = planFilteredBlobBatch(blobs);
  const hostile = Buffer.concat([Buffer.from([0, 13, 10, 0]), Buffer.from(`${ID_B} blob 3\0\0deadbeef missing\0`)]);
  for (const bodies of [[Buffer.alloc(0), hostile], [hostile, Buffer.alloc(0)]]) {
    const parsed = parseFilteredBlobBatch(respond(batch, bodies), batch);
    assert.deepEqual(parsed.get("a b.txt"), bodies[0]);
    assert.deepEqual(parsed.get("b.bin"), bodies[1]);
  }
});

test("every batch gets markers its files cannot predict", () => {
  const markers = (batch: FilteredBlobBatch) => batch.requests.map(({ marker }) => marker);
  const [first, second] = [markers(planFilteredBlobBatch(blobs)), markers(planFilteredBlobBatch(blobs))];
  assert.equal(new Set([...first, ...second]).size, 4);
});

test("output that does not account for every request is refused", () => {
  const batch = planFilteredBlobBatch(blobs);
  const whole = respond(batch, [Buffer.from("one"), Buffer.from("two")]);
  assert.throws(() => parseFilteredBlobBatch(whole.subarray(0, whole.length - 5), batch), /truncated/u);
  assert.throws(() => parseFilteredBlobBatch(Buffer.concat([whole, Buffer.from("x")]), batch), /unexpected/u);
  assert.throws(() => parseFilteredBlobBatch(Buffer.from(`${ID_A} missing\0`), batch), /no filtered blob/u);
  assert.throws(() => parseFilteredBlobBatch(Buffer.alloc(0), batch), /no filtered blob/u);
});
