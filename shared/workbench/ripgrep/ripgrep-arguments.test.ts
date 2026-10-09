/* No production exports. Tests protect rg-style flag parsing: combined and attached values, flag ends, repeats, unrestricted levels and rejections. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRipgrepArguments } from "./ripgrep-arguments";

function parsed(args: string[]) {
  const result = parseRipgrepArguments(args);
  if (result.kind === "rejected") assert.fail(result.message);
  return result.query;
}

test("parses combined short flags, attached values and context precedence", () => {
  const query = parsed(["-iw", "-A2", "--context=3", "foo", "src", "docs"]);
  assert.equal(query.caseMode, "insensitive");
  assert.equal(query.wordRegexp, true);
  assert.equal(query.afterContext, 2);
  assert.equal(query.beforeContext, 3);
  assert.deepEqual(query.patterns, ["foo"]);
  assert.deepEqual(query.paths, ["src", "docs"]);
});

test("repeated -e patterns make every positional a path, and -- ends flag parsing", () => {
  const query = parsed(["-e", "a", "-e", "-b", "--", "-c", "dir"]);
  assert.deepEqual(query.patterns, ["a", "-b"]);
  assert.deepEqual(query.paths, ["-c", "dir"]);
  assert.equal(query.mode, "lines");
});

test("unrestricted levels widen ignore, hidden and binary handling in order", () => {
  assert.deepEqual(
    [["-u", "x"], ["-uu", "x"], ["-uuu", "x"]].map(args => {
      const { noIgnore, hidden, binary } = parsed(args);
      return [noIgnore, hidden, binary];
    }),
    [[true, false, false], [true, true, false], [true, true, true]],
  );
});

test("--files treats every positional as a path", () => {
  const query = parsed(["--files", "-g", "*.ts", "src"]);
  assert.equal(query.mode, "files");
  assert.deepEqual(query.paths, ["src"]);
});

test("rejects unsupported flags, missing values, unknown types and a missing pattern", () => {
  for (const args of [["-P", "x"], ["--json", "x"], ["--no-heading=1", "x"], ["-A"], ["-t", "nope", "x"], ["-n"]]) {
    assert.equal(parseRipgrepArguments(args).kind, "rejected", args.join(" "));
  }
});
