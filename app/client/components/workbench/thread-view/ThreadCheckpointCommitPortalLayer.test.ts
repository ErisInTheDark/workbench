/*
 * No production exports. Tests protect proposal portal relocation across independent anchor lifecycles.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { moveThreadCheckpointCommitHost, ThreadCheckpointCommitAnchorRegistry } from "./ThreadCheckpointCommitPortalLayer";

function portalDom() {
  const document = {} as Document;
  const moves: string[] = [];
  function element(id: string, connected = true, atomicMove = false, ownerDocument = document) {
    const node = {
      id,
      isConnected: connected,
      ownerDocument,
      parentNode: null as HTMLDivElement | null,
      insertBefore(host: HTMLDivElement, before: Node | null) {
        assert.equal(before, null);
        moves.push(`insert:${id}`);
        Object.assign(host, { parentNode: node, isConnected: node.isConnected, ownerDocument });
        return host;
      },
      ...(atomicMove ? {
        moveBefore(host: HTMLDivElement, before: Node | null) {
          assert.equal(before, null);
          assert.equal(host.ownerDocument, ownerDocument);
          assert.equal(host.isConnected, node.isConnected);
          moves.push(`move:${id}`);
          Object.assign(host, { parentNode: node });
        },
      } : {}),
    };
    return node as HTMLDivElement;
  }
  return { element, moves };
}

test("proposal hosts relocate without moveBefore and skip repeated placement", () => {
  const { element, moves } = portalDom();
  const source = element("source");
  const target = element("target");
  const host = element("host", false);

  moveThreadCheckpointCommitHost(host, source);
  moveThreadCheckpointCommitHost(host, target);
  moveThreadCheckpointCommitHost(host, target);

  assert.equal(host.parentNode, target);
  assert.deepEqual(moves, ["insert:source", "insert:target"]);
});

test("supported browsers use atomic moves when relocating a connected proposal", () => {
  const { element, moves } = portalDom();
  const host = element("host", false);
  const source = element("source", true, true);
  const target = element("target", true, true);

  moveThreadCheckpointCommitHost(host, source);
  moveThreadCheckpointCommitHost(host, target);

  assert.equal(host.parentNode, target);
  assert.deepEqual(moves, ["insert:source", "move:target"]);
});

test("proposal moves use insertion when destination connectivity or document differs", () => {
  const { element, moves } = portalDom();
  const host = element("host");
  const detached = element("detached", false, true);
  const otherDocument = element("other-document", true, true, {} as Document);

  moveThreadCheckpointCommitHost(host, detached);
  moveThreadCheckpointCommitHost(host, element("source"));
  moveThreadCheckpointCommitHost(host, otherDocument);

  assert.equal(host.parentNode, otherDocument);
  assert.deepEqual(moves, ["insert:detached", "insert:source", "insert:other-document"]);
});

test("missing-api proposal hosts park and return as anchors disappear and reappear", () => {
  const { element } = portalDom();
  const registry = new ThreadCheckpointCommitAnchorRegistry();
  const parking = element("parking");
  const source = element("source");
  const target = element("target");
  const host = element("host", false);
  const reconcile = () => {
    const destination = registry.getDestination("proposal", "target", parking);
    if (destination) moveThreadCheckpointCommitHost(host, destination);
  };
  const unsubscribe = registry.subscribe("proposal", reconcile);
  reconcile();
  assert.equal(host.parentNode, parking);
  registry.setAnchor("proposal", "source", source);
  assert.equal(host.parentNode, source);
  registry.setAnchor("proposal", "target", target);
  assert.equal(host.parentNode, target);
  registry.setAnchor("proposal", "target", null);
  assert.equal(host.parentNode, source);
  registry.setAnchor("proposal", "source", null);
  assert.equal(host.parentNode, parking);
  registry.setAnchor("proposal", "source", source);
  assert.equal(host.parentNode, source);
  unsubscribe();
  moveThreadCheckpointCommitHost(host, parking);
  assert.equal(host.parentNode, parking);
});

test("a late source anchor restores a proposal after its lifecycle target unmounts", () => {
  const registry = new ThreadCheckpointCommitAnchorRegistry();
  const parking = { id: "parking" } as HTMLDivElement;
  const source = { id: "source" } as HTMLDivElement;
  const target = { id: "target" } as HTMLDivElement;
  const destinations: Array<HTMLDivElement | null> = [];
  const reconcile = () => destinations.push(registry.getDestination("proposal", "source", parking));
  const unsubscribe = registry.subscribe("proposal", reconcile);

  registry.setAnchor("proposal", "target", target);
  registry.setAnchor("proposal", "target", null);
  registry.setAnchor("proposal", "source", source);

  assert.deepEqual(destinations, [target, parking, source]);
  unsubscribe();
});
