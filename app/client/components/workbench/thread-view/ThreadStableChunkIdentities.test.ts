/*
 * No exports. Tests protect transcript group and chunk identity across history prepends, live appends and regrouping.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadStableChunkIdentities from "./ThreadStableChunkIdentities";

const keys = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `e${from + index}`);

function render(identities: ThreadStableChunkIdentities, groups: string[][], size = 3) {
  const groupIds = identities.groups(groups);
  return groups.map((group, index) => ({
    group: groupIds[index]!,
    chunks: identities.chunks(groupIds[index]!, group, size).map(chunk => [chunk.identity, group.slice(chunk.start, chunk.end)] as const),
  }));
}

test("history landing above keeps every rendered group and chunk, adding only above", () => {
  const identities = new ThreadStableChunkIdentities();
  const before = render(identities, [keys(10, 17), keys(17, 18)]);
  const after = render(identities, [keys(5, 17), keys(17, 18)]);
  assert.equal(after[0]!.group, before[0]!.group);
  assert.equal(after[1]!.group, before[1]!.group);
  assert.deepEqual(after[0]!.chunks.slice(-3), before[0]!.chunks, "rendered chunks keep identity and boundaries");
  assert.deepEqual(after[0]!.chunks.slice(0, -3).map(([, entries]) => entries), [["e5", "e6"], ["e7", "e8", "e9"]]);
});

test("a partial top chunk filled by history keeps its identity", () => {
  const identities = new ThreadStableChunkIdentities();
  render(identities, [keys(10, 16)]);
  const partial = render(identities, [keys(9, 16)])[0]!.chunks;
  assert.deepEqual(partial[0]![1], ["e9"]);
  const filled = render(identities, [keys(7, 16)])[0]!.chunks;
  assert.deepEqual(filled[0], [partial[0]![0], ["e7", "e8", "e9"]]);
});

test("live entries landing below keep rendered chunks and start new ones", () => {
  const identities = new ThreadStableChunkIdentities();
  const before = render(identities, [keys(0, 4)])[0]!;
  const after = render(identities, [keys(0, 7)])[0]!;
  assert.equal(after.group, before.group);
  assert.deepEqual(after.chunks.map(([identity]) => identity).slice(0, 2), before.chunks.map(([identity]) => identity));
  assert.deepEqual(after.chunks.map(([, entries]) => entries), [["e0", "e1", "e2"], ["e3", "e4", "e5"], ["e6"]]);
});

test("a split group leaves the original identity with its newer half and gives the older half a new one", () => {
  const identities = new ThreadStableChunkIdentities();
  const [whole] = render(identities, [keys(0, 6)]);
  const [older, newer] = render(identities, [keys(0, 2), keys(2, 6)]);
  assert.equal(newer!.group, whole!.group);
  assert.notEqual(older!.group, whole!.group);
});
