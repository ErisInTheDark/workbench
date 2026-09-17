/*
 * No production exports. Tests protect proposal portal relocation across independent anchor lifecycles.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ThreadCheckpointCommitAnchorRegistry } from "./ThreadCheckpointCommitPortalLayer";

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
