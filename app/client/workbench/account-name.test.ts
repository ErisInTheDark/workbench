/* Exports: none. Protect account-label privacy while distinguishing accounts where prefixes allow it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountName } from "./account-name";

test("account masks distinguish different starts without exposing full identities", () => {
  const labels = ["chiri@example.test", "claude@example.test"];
  const names = labels.map(label => AccountName.mask(label, labels.filter(other => other !== label)));
  assert.notEqual(names[0]!.short, names[1]!.short);
  for (const [index, name] of names.entries()) {
    assert.equal(name.full, labels[index]);
    assert.equal(name.short.includes("@"), false);
    assert.equal(name.short.includes(name.full), false);
  }
});

test("domain collisions, duplicates and prefix collisions never reveal the complete label", () => {
  for (const labels of [
    ["same@one.test", "same@two.test"],
    ["duplicate@example.test", "duplicate@example.test"],
    ["a@example.test", "anna@example.test"],
    ["work", "workplace"],
    ["x", "x"],
    ["", ""],
  ]) {
    for (const [index, label] of labels.entries()) {
      const name = AccountName.mask(label, labels.filter((_other, otherIndex) => index !== otherIndex));
      assert.equal(name.full, label);
      assert.equal(name.short.includes("@"), false);
      if (label) assert.equal(name.short.includes(label), false);
    }
  }
});
